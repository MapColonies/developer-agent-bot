import { describe, expect, it } from 'vitest';
import { AGENT_GUARDRAILS } from '@src/agent/prompt';
import { buildAgentOptions, DEFAULT_MODEL, foldMessages, MODEL_TOOLS } from '@src/agent/sdkOptions';
import type { AgentSettings } from '@src/agent/sdkOptions';
import type { AgentRunRequest } from '@src/agent/types';

const request: AgentRunRequest = {
  task: { key: 'MAPCO-11434', summary: 'raster-shared: add a retry', description: 'do the thing' },
  workdir: '/workspace/raster-shared',
  maxTurns: 12,
};

/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */
const settings: AgentSettings = {
  apiKey: 'sk-from-the-secret',
  env: {
    PATH: '/usr/bin',
    HOME: '/home/node',
    GITHUB_TOKEN: 'ghp_pushable',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-of-a-person',
    ANTHROPIC_API_KEY: 'sk-ambient-and-stale',
    MCP_ATLASSIAN_URL: 'http://mcp-atlassian:8080/sse',
  },
};
/* eslint-enable @typescript-eslint/naming-convention */

/* eslint-disable @typescript-eslint/naming-convention -- the Agent SDK's message wire format */
/** An attempted tool call, with the id its result will quote back. */
function attempted(name: string, id: string): unknown {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } };
}

/** The SDK's answer to one tool call. No `is_error` means it worked. */
function settled(id: string, isError = false): unknown {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'ok' }] } };
}

/**
 * A write that landed: the attempt, and the result proving it.
 *
 * Two messages rather than one because that is what the SDK emits and what the worker has to
 * read — the attempt alone does not mean the tree changed.
 */
function wrote(name: string, id = 'toolu_write'): unknown[] {
  return [attempted(name, id), settled(id)];
}

function read(name: string): unknown {
  return {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'looking' },
        { type: 'tool_use', id: `toolu_${name}`, name, input: {} },
      ],
    },
  };
}

function result(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Added a retry to the fetch helper.',
    modelUsage: { 'claude-opus-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 7, costUSD: 0.5 } },
    permission_denials: [],
    ...overrides,
  };
}
/* eslint-enable @typescript-eslint/naming-convention */

describe('buildAgentOptions', () => {
  it('should give the model file tools and nothing else.', () => {
    // The exact list, on purpose: this assertion is what fails the moment someone widens the
    // model's reach, which is the acceptance criterion the whole ticket turns on.
    expect(buildAgentOptions(request, settings).tools).toStrictEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'TodoWrite']);
  });

  it('should offer the model no shell, under any of its names.', () => {
    const { tools } = buildAgentOptions(request, settings);

    expect(tools.filter((tool) => /bash|shell|exec|command/iu.test(tool))).toStrictEqual([]);
  });

  it('should deny a shell, a subagent, the network and every MCP tool by name as well.', () => {
    // Absent from `tools` already; denied too, because a deny rule outranks every other step
    // of the permission flow, including a mode that would otherwise approve everything.
    const { disallowedTools } = buildAgentOptions(request, settings);

    expect(disallowedTools).toContain('Bash');
    expect(disallowedTools).toContain('PowerShell');
    expect(disallowedTools).toContain('Agent');
    expect(disallowedTools).toContain('WebFetch');
    expect(disallowedTools).toContain('mcp__*');
  });

  it('should deny the worktree tools, which are git by another name.', () => {
    const { disallowedTools } = buildAgentOptions(request, settings);

    expect(disallowedTools).toContain('EnterWorktree');
    expect(disallowedTools).toContain('ExitWorktree');
  });

  it('should deny rather than prompt, because a prompt in a pod is a hang.', () => {
    expect(buildAgentOptions(request, settings).permissionMode).toBe('dontAsk');
  });

  it('should read no settings file from the clone, which could otherwise widen its own permissions.', () => {
    const options = buildAgentOptions(request, settings);

    expect(options.settingSources).toStrictEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toStrictEqual({});
  });

  it('should authenticate with the key it was handed, not with whatever the environment held.', () => {
    expect(buildAgentOptions(request, settings).env['ANTHROPIC_API_KEY']).toBe('sk-from-the-secret');
  });

  it('should not pass the interactive-login credential to the model, so the run cannot authenticate as a person.', () => {
    expect(buildAgentOptions(request, settings).env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });

  it('should not hand the model a GitHub token it could push with.', () => {
    const { env } = buildAgentOptions(request, settings);

    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['MCP_ATLASSIAN_URL']).toBeUndefined();
  });

  it('should keep the environment a process needs to run at all.', () => {
    const { env } = buildAgentOptions(request, settings);

    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/node');
  });

  it('should work inside the clone, with the turn budget it was given.', () => {
    const options = buildAgentOptions(request, settings);

    expect(options.cwd).toBe('/workspace/raster-shared');
    expect(options.maxTurns).toBe(12);
  });

  it("should use this worker's model unless it is told otherwise.", () => {
    expect(buildAgentOptions(request, settings).model).toBe(DEFAULT_MODEL);
    expect(buildAgentOptions(request, { ...settings, model: 'claude-something-else' }).model).toBe('claude-something-else');
  });

  it('should append the guardrails to the coding preset rather than replacing it.', () => {
    const { systemPrompt } = buildAgentOptions(request, settings);

    expect(systemPrompt).toStrictEqual({ type: 'preset', preset: 'claude_code', append: AGENT_GUARDRAILS });
  });

  it('should only ever auto-approve tools that exist.', () => {
    const options = buildAgentOptions(request, settings);

    expect(options.allowedTools).toStrictEqual([...MODEL_TOOLS]);
  });
});

describe('foldMessages', () => {
  it('should report a run that wrote a file as a change.', () => {
    expect(foldMessages([...wrote('Edit'), result()]).outcome).toBe('changed');
  });

  it('should report a write the tool refused as no change, not a change.', () => {
    // The bug this replaced: an `Edit` whose `old_string` did not match produced a `tool_use`
    // block and no edit, and the worker went on to test a pristine clone, watch the repo's own
    // suite pass, and certify a verified diff that did not exist.
    const messages = [attempted('Edit', 'toolu_1'), settled('toolu_1', true), result()];

    expect(foldMessages(messages).outcome).toBe('no-change');
  });

  it('should report a write that never came back at all as no change.', () => {
    // A denied call, or one the run ended before answering, has no `tool_result` to pair with.
    expect(foldMessages([attempted('Write', 'toolu_1'), result()]).outcome).toBe('no-change');
  });

  it('should report a change when one write landed among others that failed.', () => {
    const messages = [attempted('Edit', 'toolu_1'), settled('toolu_1', true), attempted('Write', 'toolu_2'), settled('toolu_2'), result()];

    expect(foldMessages(messages).outcome).toBe('changed');
  });

  it('should not read a successful read as a write.', () => {
    // The pairing is by id, so a `tool_result` answering `Grep` must not satisfy an unrelated
    // write attempt.
    const messages = [read('Grep'), settled('toolu_Grep'), attempted('Edit', 'toolu_1'), result()];

    expect(foldMessages(messages).outcome).toBe('no-change');
  });

  it('should report a run that only read as no change.', () => {
    // Not a failure to report: there is nothing to verify, and the caller must not spend a
    // second attempt on identical input.
    expect(foldMessages([read('Read'), read('Grep'), result()]).outcome).toBe('no-change');
  });

  it('should report a run whose turn never completed as a give-up.', () => {
    expect(foldMessages([...wrote('Write')]).outcome).toBe('gave-up');
  });

  it('should report an exhausted turn budget as a give-up even though files were written.', () => {
    // A run cut off mid-edit is more likely half-applied than done, so the truth beats the
    // optimistic reading — see the note on `foldMessages`.
    const run = foldMessages([...wrote('Write'), result({ subtype: 'error_max_turns' })]);

    expect(run.outcome).toBe('gave-up');
    expect(run.summary).toContain('error_max_turns');
  });

  it('should report a successful subtype that carries an error as a give-up.', () => {
    /* eslint-disable-next-line @typescript-eslint/naming-convention -- the SDK's wire format */
    expect(foldMessages([...wrote('Edit'), result({ is_error: true })]).outcome).toBe('gave-up');
  });

  it('should add up what every model in the run cost.', () => {
    const usage = {
      'claude-opus-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 7, costUSD: 0.5 },
      'claude-haiku-4-5': { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, costUSD: 0.25 },
    };

    expect(foldMessages([...wrote('Edit'), result({ modelUsage: usage })]).usage).toStrictEqual({
      input: 110,
      output: 21,
      cacheRead: 7,
      costUsd: 0.75,
    });
  });

  it('should read the last result, because each one carries the running total.', () => {
    const first = result({ modelUsage: { 'claude-opus-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, costUSD: 0.5 } } });
    const last = result({ modelUsage: { 'claude-opus-5': { inputTokens: 300, outputTokens: 60, cacheReadInputTokens: 0, costUSD: 1.5 } } });

    expect(foldMessages([...wrote('Edit'), first, last]).usage).toStrictEqual({ input: 300, output: 60, cacheRead: 0, costUsd: 1.5 });
  });

  it('should report each tool the permission layer refused, once.', () => {
    /* eslint-disable @typescript-eslint/naming-convention -- the SDK's wire format */
    const denials = [
      { tool_name: 'Bash', tool_use_id: 'a', tool_input: {} },
      { tool_name: 'Bash', tool_use_id: 'b', tool_input: {} },
    ];

    expect(foldMessages([read('Read'), result({ permission_denials: denials })]).deniedTools).toStrictEqual(['Bash']);
    /* eslint-enable @typescript-eslint/naming-convention */
  });

  it('should survive a stream carrying things it does not understand.', () => {
    // Read defensively on purpose: the SDK's message union is large and moves quickly, and a
    // new message type must not be able to stop the worker.
    const messages = [null, 'system', 42, { type: 'stream_event', event: {} }, ...wrote('Edit'), result()];

    expect(foldMessages(messages).outcome).toBe('changed');
  });

  it('should report no usage at all when the run produced no result.', () => {
    expect(foldMessages([]).usage).toStrictEqual({ input: 0, output: 0, cacheRead: 0, costUsd: 0 });
  });
});
