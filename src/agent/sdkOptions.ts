import { tail, withoutSecrets } from '../workspace/subprocess';
import { AGENT_GUARDRAILS } from './prompt';
import { NO_USAGE } from './usage';
import type { AgentOutcome, AgentRun, AgentRunRequest, TokenUsage } from './types';

/**
 * Everything about the Agent SDK call except the call itself.
 *
 * Split out from `sdkAgent.ts` so the two things worth testing — the tool surface handed to
 * the model, and how a message stream is read back — can be tested as values, with no
 * network, no API key and no dependency on the SDK being installed. `sdkAgent.ts` is then
 * thin enough to read in one sitting, and is the only file in the repository that imports
 * `@anthropic-ai/claude-agent-sdk`.
 *
 * The types here restate the parts of the SDK's `Options` and message shapes that the worker
 * uses. That is deliberate: `sdkAgent.ts` passes this object straight to `query`, so if a
 * field name or a literal ever drifts, the compiler says so at that one seam instead of the
 * options silently doing nothing.
 */

/** The model this worker uses. */
const DEFAULT_MODEL = 'claude-opus-5';

/**
 * The model's entire tool surface: read the repository, search it, change files, keep its own
 * plan. Nothing here reaches the network or a shell.
 *
 * This list is the security control for MAPCO-11434's "no git and no GitHub". `tools` is the
 * SDK's own base-set option — the tools not named here are never built for the session, so
 * there is no `Bash` for the model to reach for, no subagent it can delegate a `git push` to,
 * and no MCP server it can be handed. A sentence in a prompt asking it not to use git would
 * satisfy nothing; this is not a sentence.
 */
const MODEL_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'TodoWrite'] as const;

/**
 * The tools that can change the working tree.
 *
 * Naming one of these is not evidence that the tree changed — only that the model tried. The
 * evidence is the `tool_result` that answers the call, which is why `foldMessages` pairs the
 * two rather than trusting the attempt.
 */
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;

/**
 * Denied by name as well as being absent from `MODEL_TOOLS`.
 *
 * Belt and braces, and the braces are the interesting half: a deny rule beats every other
 * step of the SDK's permission evaluation, including a permission mode that would otherwise
 * approve everything, so these stay off even if someone later widens the base set or turns on
 * a mode that skips prompts. The list is not an attempt at completeness — `MODEL_TOOLS` is
 * what makes it complete — it names the ways a model could otherwise get a shell, git, a
 * subagent, the network, or a tool the worker did not choose.
 */
const DENIED_TOOLS = [
  'Bash',
  // The Windows shell. Absent from this image, but naming only `Bash` would read as though a
  // shell were the problem rather than shells.
  'PowerShell',
  // Git worktrees, by tool rather than by command.
  'EnterWorktree',
  'ExitWorktree',
  // Subagents. A subagent gets its own tool list, so it is the one way a restriction here
  // could be widened from inside the session. `Task` is the older name for the same thing.
  'Agent',
  'Task',
  'WebFetch',
  'WebSearch',
  // Skills are prompts that arrive from disk — including from the clone, which is untrusted
  // input. They cannot conjure a tool that does not exist, but they can spend the budget.
  'Skill',
  // Every MCP tool from every server, whatever it turns out to be called.
  'mcp__*',
];

/** Longest model-written summary kept. It goes in a log line and, on a give-up, on the ticket. */
const SUMMARY_LIMIT = 2_000;
/** `Array.prototype.at` index of the last element. */
const LAST = -1;

/** Restated from the SDK: which on-disk settings files a session loads. */
type SettingSourceName = 'user' | 'project' | 'local';

/**
 * The subset of the SDK's `Options` this worker sets.
 *
 * Arrays are mutable because the SDK's own `Options` declares them so, and a `readonly`
 * array is not assignable to one. Everything is otherwise as narrow as the SDK allows, so a
 * typo in a literal like `dontAsk` fails the build rather than the run.
 */
interface AgentQueryOptions {
  readonly cwd: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly tools: string[];
  readonly allowedTools: string[];
  readonly disallowedTools: string[];
  readonly permissionMode: 'dontAsk';
  readonly settingSources: SettingSourceName[];
  readonly strictMcpConfig: true;
  readonly mcpServers: Record<string, never>;
  readonly skills: string[];
  readonly persistSession: false;
  readonly includePartialMessages: false;
  readonly systemPrompt: { readonly type: 'preset'; readonly preset: 'claude_code'; readonly append: string };
  readonly env: Record<string, string | undefined>;
}

interface AgentSettings {
  /**
   * The Anthropic API key, passed in rather than read from here.
   *
   * The worker authenticates with a key it was given — from an OpenShift Secret in the
   * cluster — and never with an interactive login. Handing it in as a value is what makes
   * that checkable: this module has no other way to authenticate, and the ambient
   * login credential is stripped out of the child environment below.
   */
  readonly apiKey: string;
  readonly model?: string;
  /** The environment the model's process derives its own from. Injectable for tests. */
  readonly env?: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];

  return typeof value === 'number' ? value : 0;
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];

  return typeof value === 'string' ? value : '';
}

/**
 * The environment the model's process runs with.
 *
 * The SDK replaces the child environment wholesale rather than merging, so `process.env` has
 * to be spread in by hand or the child loses `PATH` and `HOME`. That is also the opportunity
 * to take things away: the worker's own credentials go, including the interactive-login token
 * that could otherwise authenticate the run as a person, and the API key goes back in
 * explicitly as the one credential the model's process is meant to have.
 */
function modelEnv(settings: AgentSettings): Record<string, string | undefined> {
  return {
    ...withoutSecrets(settings.env ?? process.env),
    // eslint-disable-next-line @typescript-eslint/naming-convention -- an environment variable name
    ANTHROPIC_API_KEY: settings.apiKey,
  };
}

/** The options one run of the model is given. */
function buildAgentOptions(request: AgentRunRequest, settings: AgentSettings): AgentQueryOptions {
  return {
    cwd: request.workdir,
    model: settings.model ?? DEFAULT_MODEL,
    maxTurns: request.maxTurns,
    tools: [...MODEL_TOOLS],
    // Auto-approve exactly the tools that exist, so nothing waits on an approval no one is
    // there to give.
    allowedTools: [...MODEL_TOOLS],
    disallowedTools: [...DENIED_TOOLS],
    // Anything not pre-approved is refused outright instead of prompting. In a pod a prompt
    // is not a question, it is a hang.
    permissionMode: 'dontAsk',
    // No settings files, from anywhere. The clone is a repository off the internet: with the
    // project source enabled, its own `.claude/settings.json` would be read as permission
    // rules, letting the thing being worked on widen what may be done to it. The cost is that
    // the clone's CLAUDE.md is not loaded either, which is a real loss of local convention and
    // the right side of the trade.
    settingSources: [],
    // Same reasoning for MCP: ignore the clone's `.mcp.json` and every other configured
    // server, and pass none.
    strictMcpConfig: true,
    mcpServers: {},
    skills: [],
    // Nothing resumes these sessions, and a container filesystem is not where session
    // transcripts should accumulate.
    persistSession: false,
    includePartialMessages: false,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: AGENT_GUARDRAILS },
    env: modelEnv(settings),
  };
}

/** The content blocks of a message, or nothing if it does not carry any. */
function contentOf(message: Record<string, unknown>): Record<string, unknown>[] {
  const inner = message['message'];

  if (!isRecord(inner) || !Array.isArray(inner['content'])) {
    return [];
  }

  return (inner['content'] as unknown[]).filter(isRecord);
}

/** The ids of the write-tool calls this assistant message attempted. */
function writeToolUseIds(message: Record<string, unknown>): string[] {
  return contentOf(message)
    .filter((block) => readString(block, 'type') === 'tool_use' && (WRITE_TOOLS as readonly string[]).includes(readString(block, 'name')))
    .map((block) => readString(block, 'id'))
    .filter((id) => id !== '');
}

/**
 * The ids of the tool calls this user message reports as having succeeded.
 *
 * The SDK answers every `tool_use` with a `tool_result` carrying the same id, and marks the
 * ones that did not work with `is_error`. A missing `is_error` means success, so this tests for
 * the failure explicitly rather than reading a falsy value as a pass.
 *
 * A call that was denied, or that the run never got back to, has no `tool_result` at all — so
 * it is absent from here, which is the answer the worker wants.
 */
function settledToolUseIds(message: Record<string, unknown>): string[] {
  return contentOf(message)
    .filter((block) => readString(block, 'type') === 'tool_result' && block['is_error'] !== true)
    .map((block) => readString(block, 'tool_use_id'))
    .filter((id) => id !== '');
}

/**
 * Did the model actually change the tree?
 *
 * Only if a write it attempted came back without an error. Reading the attempt alone was a
 * real bug and a quiet one: an `Edit` whose `old_string` did not match, or a `Write` the
 * permission layer refused, produced a `tool_use` block and no change, and the worker went on
 * to run the clone's suite against a pristine tree, watch it pass, and report a verified diff
 * that did not exist. Since certifying the diff is the entire point of this slice, the write
 * has to be observed landing, not requested.
 */
function wroteFiles(messages: readonly Record<string, unknown>[]): boolean {
  const attempted = new Set(messages.filter((message) => readString(message, 'type') === 'assistant').flatMap(writeToolUseIds));

  if (attempted.size === 0) {
    return false;
  }

  return messages
    .filter((message) => readString(message, 'type') === 'user')
    .flatMap(settledToolUseIds)
    .some((id) => attempted.has(id));
}

/**
 * Tokens and cost for the whole run.
 *
 * `modelUsage` rather than `usage`: the SDK documents `usage` as the main agent loop only,
 * while `modelUsage` covers every model call the run made, which is what the worker is billed
 * for. It is a running total carried on each result, so this reads the last one rather than
 * adding them up.
 */
function usageOf(result: Record<string, unknown>): TokenUsage {
  const perModel = result['modelUsage'];

  if (!isRecord(perModel)) {
    return NO_USAGE;
  }

  return Object.values(perModel)
    .filter(isRecord)
    .reduce<TokenUsage>(
      (total, model) => ({
        input: total.input + readNumber(model, 'inputTokens'),
        output: total.output + readNumber(model, 'outputTokens'),
        cacheRead: total.cacheRead + readNumber(model, 'cacheReadInputTokens'),
        costUsd: total.costUsd + readNumber(model, 'costUSD'),
      }),
      NO_USAGE
    );
}

function deniedIn(result: Record<string, unknown>): string[] {
  const denials = result['permission_denials'];

  if (!Array.isArray(denials)) {
    return [];
  }

  const names = (denials as unknown[]).filter(isRecord).map((denial) => readString(denial, 'tool_name'));

  return [...new Set(names)].filter((name) => name !== '');
}

function outcomeOf(failed: boolean, wrote: boolean): AgentOutcome {
  if (failed) {
    return 'gave-up';
  }

  return wrote ? 'changed' : 'no-change';
}

function summaryOf(result: Record<string, unknown>, failed: boolean): string {
  const errors = result['errors'];
  const reported = Array.isArray(errors) ? (errors as unknown[]).map(String).join('; ') : '';
  const text = failed
    ? `${readString(result, 'subtype')}: ${reported === '' ? readString(result, 'result') : reported}`
    : readString(result, 'result');

  return tail(text.trim(), SUMMARY_LIMIT);
}

/**
 * Read a finished message stream as one observable outcome.
 *
 * Written against `unknown` and narrowed field by field rather than against the SDK's message
 * union. The union is large and moves quickly, and this only cares about four things — did a
 * turn complete, did it complete well, did a file change, what did it cost. Reading it
 * defensively means a new message type or a renamed sibling field cannot stop the worker, and
 * it is what lets the tests drive this with plain objects.
 *
 * "Did a file change" is answered across two messages, not one: the assistant's `tool_use` is
 * the request, and the `tool_result` in the following user message is the outcome. See
 * `wroteFiles` for why the attempt on its own is not good enough.
 *
 * A stream with no result message at all is a give-up: the SDK emits exactly one per turn, so
 * its absence means the run did not finish, whatever else arrived.
 *
 * Note that `gave-up` wins over `changed`. A run cut off by its turn budget may well have left
 * a half-applied edit behind, and testing a half-change is worse than reporting the truth.
 */
function foldMessages(messages: readonly unknown[]): AgentRun {
  const records = messages.filter(isRecord);
  const wrote = wroteFiles(records);
  const results = records.filter((message) => readString(message, 'type') === 'result');
  const result = results.at(LAST);

  if (result === undefined) {
    return {
      outcome: 'gave-up',
      usage: NO_USAGE,
      summary: 'The model produced no result: the run ended before the turn completed.',
      deniedTools: [],
    };
  }

  const failed = readString(result, 'subtype') !== 'success' || result['is_error'] === true;

  return {
    outcome: outcomeOf(failed, wrote),
    usage: usageOf(result),
    summary: summaryOf(result, failed),
    deniedTools: deniedIn(result),
  };
}

export { buildAgentOptions, DEFAULT_MODEL, DENIED_TOOLS, foldMessages, MODEL_TOOLS, WRITE_TOOLS };
export type { AgentQueryOptions, AgentSettings };
