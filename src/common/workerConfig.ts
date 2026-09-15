/**
 * Worker knobs.
 *
 * Deliberately env-based rather than `@map-colonies/config`. That library resolves a
 * schema published in `@map-colonies/schemas`, and no schema exists for this service yet;
 * the telemetry half still goes through it (see `common/config.ts`) because
 * `commonBoilerplateV3` already covers logger and tracing. Registering a real schema for
 * these knobs is follow-up work, not a blocker for the current slice.
 */

import { tmpdir } from 'node:os';
import type { BudgetConfig } from '../budget/types';
import type { BotIdentity } from '../tickets/claim';
import type { GitIdentity } from '../vcs/types';

interface WorkerConfig {
  /** How often the internal scheduler runs a cycle. */
  readonly pollIntervalMs: number;
  /** How many tickets one cycle may start. Defaults to 1 per MAPCO-11429. */
  readonly maxTicketsPerRun: number;
  /** How many tickets may be in flight at once. Defaults to 1 per MAPCO-11429. */
  readonly maxConcurrentTickets: number;
  /** Base URL of the in-cluster `atlassian-write` MCP server. */
  readonly mcpUrl: string;
  /** Who the worker claims tickets as. Both halves are required — see `BotIdentity`. */
  readonly bot: BotIdentity;
  /**
   * The worker's own cost ceilings (MAPCO-11435): how much one ticket may spend, and how many
   * tickets a day may start. Config rather than constants so the rollout can start slow and
   * ramp as quality is proven.
   *
   * Optional on the *type* only, and never absent in practice: `loadWorkerConfig` always fills
   * it in, so every deployed and dry-run worker has all three ceilings. It is optional because
   * a required field would have broken every hand-written `WorkerConfig` literal in the suite
   * the moment this slice landed, and a spend ceiling is not worth a fleet of unrelated
   * compile errors. Read it through `budgetOf`, never directly: absence there means the
   * conservative defaults below, and never "no ceiling".
   */
  readonly budget?: BudgetConfig;
  /**
   * Where the per-ticket clones are made.
   *
   * A mounted volume in the pod, `os.tmpdir()` on a laptop. A container's root filesystem is
   * read-only under the org's OpenShift policy and a clone plus its `node_modules` is not small,
   * so this is a `emptyDir` in the chart rather than wherever the process happens to start.
   */
  readonly workspaceRoot: string;
  /**
   * Who the worker's commits are authored by.
   *
   * Configured rather than derived, because the real answer belongs to the GitHub App
   * (MAPCO-11428): once it exists this is `{app-slug}[bot]` and
   * `{app-id}+{app-slug}[bot]@users.noreply.github.com`, and the app id is not something this
   * worker can know. The defaults are a valid `users.noreply.github.com` address in the
   * meantime, so a commit is attributable and GitHub accepts it.
   */
  readonly commitIdentity: GitIdentity;
  /** Overrides the model the agent runs. Unset means `DEFAULT_MODEL` in agent/sdkOptions.ts. */
  readonly model?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 300_000;

/**
 * Conservative on purpose. A metered API key has no ceiling of its own, so these three are the
 * only thing standing between a stuck agent and an invoice — a default that costs a few dollars
 * to discover is the right default, and raising it is a deployment decision someone makes on
 * purpose rather than one they inherit.
 *
 * There is deliberately no value meaning "unlimited": `readInt` refuses anything below 1, so a
 * ceiling cannot be switched off with an env var. One that can is one that gets switched off
 * during an incident and stays off.
 */
const DEFAULT_MAX_TOKENS_PER_TICKET = 200_000;
const DEFAULT_MAX_TURNS_PER_TICKET = 40;
const DEFAULT_MAX_TICKETS_PER_DAY = 5;

/** The ceilings a worker gets when nothing configured any: the conservative ones, never none. */
const DEFAULT_BUDGET: BudgetConfig = {
  ticket: { maxTokens: DEFAULT_MAX_TOKENS_PER_TICKET, maxTurns: DEFAULT_MAX_TURNS_PER_TICKET },
  maxTicketsPerDay: DEFAULT_MAX_TICKETS_PER_DAY,
};

/**
 * Who a commit is authored by until the GitHub App exists.
 *
 * A `users.noreply.github.com` address is the form GitHub accepts without asking whether the
 * mailbox is real, and the `[bot]` suffix is the convention that makes a machine author
 * recognisable in `git log` and in a review. It is deliberately not a person's address: an
 * agent-authored commit must never look like somebody's work.
 */
const DEFAULT_COMMIT_IDENTITY: GitIdentity = {
  name: 'mapcolonies-developer-agent[bot]',
  email: 'mapcolonies-developer-agent[bot]@users.noreply.github.com',
};

class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }

  return parsed;
}

/** An optional string, with absent and empty treated the same — a helm value is often `""`. */
function readText(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name]?.trim() ?? '';

  return raw === '' ? fallback : raw;
}

function readRequired(env: NodeJS.ProcessEnv, name: string, why: string): string {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    throw new ConfigError(`${name} must be set — ${why}`);
  }

  return raw;
}

/**
 * The spend ceilings this config carries, or the conservative defaults if it carries none.
 *
 * The one way to read `WorkerConfig.budget`. An absent field is a config object written before
 * the ceilings existed — a test literal, or an older caller — and the safe reading of that is
 * "the defaults", not "unlimited". Going the other way would make a forgotten field the most
 * expensive kind of typo there is.
 */
function budgetOf(config: WorkerConfig): BudgetConfig {
  return config.budget ?? DEFAULT_BUDGET;
}

function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const mcpUrl = readRequired(env, 'MCP_ATLASSIAN_URL', 'the worker has no Jira credentials of its own');
  const bot: BotIdentity = {
    account: readRequired(env, 'JIRA_BOT_ACCOUNT', 'the worker has no way to put its own name on a ticket'),
    displayName: readRequired(env, 'JIRA_BOT_DISPLAY_NAME', "the worker could not tell its own claims from a human's"),
  };

  // Both halves of the per-ticket ceiling are read, never derived from each other: a stuck
  // agent can burn its turns on cheap calls, and one huge context can burn its tokens in a
  // handful of turns. Whichever runs out first stops the ticket.
  const budget: BudgetConfig = {
    ticket: {
      maxTokens: readInt(env, 'MAX_TOKENS_PER_TICKET', DEFAULT_BUDGET.ticket.maxTokens),
      maxTurns: readInt(env, 'MAX_TURNS_PER_TICKET', DEFAULT_BUDGET.ticket.maxTurns),
    },
    maxTicketsPerDay: readInt(env, 'MAX_TICKETS_PER_DAY', DEFAULT_BUDGET.maxTicketsPerDay),
  };

  const model = env['AGENT_MODEL']?.trim() ?? '';

  return {
    pollIntervalMs: readInt(env, 'POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    maxTicketsPerRun: readInt(env, 'MAX_TICKETS_PER_RUN', 1),
    maxConcurrentTickets: readInt(env, 'MAX_CONCURRENT_TICKETS', 1),
    mcpUrl,
    bot,
    budget,
    workspaceRoot: readText(env, 'WORKSPACE_ROOT', tmpdir()),
    commitIdentity: {
      name: readText(env, 'AGENT_GIT_NAME', DEFAULT_COMMIT_IDENTITY.name),
      email: readText(env, 'AGENT_GIT_EMAIL', DEFAULT_COMMIT_IDENTITY.email),
    },
    // Absent rather than empty, so `sdkOptions` falls back to its own default instead of asking
    // the SDK for a model called "".
    ...(model === '' ? {} : { model }),
  };
}

export { budgetOf, ConfigError, DEFAULT_BUDGET, DEFAULT_COMMIT_IDENTITY, loadWorkerConfig };
export type { WorkerConfig };
