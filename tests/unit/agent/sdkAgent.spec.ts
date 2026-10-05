import { describe, expect, it } from 'vitest';
import { SdkAgent, type RunQuery } from '@src/agent/sdkAgent';
import type { AgentQueryOptions, AgentSettings } from '@src/agent/sdkOptions';
import type { AgentRunRequest } from '@src/agent/types';

const request: AgentRunRequest = {
  task: { key: 'MAPCO-11434', summary: 'raster-shared: add a retry', description: 'The helper gives up on the first 503.' },
  workdir: '/workspace/raster-shared',
  maxTurns: 9,
};

/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */
const settings: AgentSettings = {
  credential: { mode: 'api-key', source: 'ANTHROPIC_API_KEY', value: 'sk-from-the-secret' },
  env: { PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_pushable' },
};
/* eslint-enable @typescript-eslint/naming-convention */

interface Call {
  readonly prompt: string;
  readonly options: AgentQueryOptions;
}

/**
 * Stands in for the SDK's `query`, recording what it was handed.
 *
 * The seam this covers is the one thing about `SdkAgent` an outside observer can check: that
 * the options `buildAgentOptions` produced — the tool list the no-git criterion rests on —
 * reach the SDK unmodified, rather than being built and then quietly widened on the way past.
 */
function fakeQuery(messages: unknown[]): RunQuery & { calls: Call[] } {
  const calls: Call[] = [];

  const runQuery = (params: Call): AsyncIterable<unknown> => {
    calls.push(params);

    return (async function* stream(): AsyncGenerator {
      for (const message of messages) {
        yield await Promise.resolve(message);
      }
    })();
  };

  return Object.assign(runQuery, { calls });
}

/* eslint-disable @typescript-eslint/naming-convention -- the Agent SDK's message wire format */
const editedAFile = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: {} }] } };
/** The result that proves the edit landed. A write is only a change once this comes back. */
const editSucceeded = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'ok' }] } };
const wroteAFile = [editedAFile, editSucceeded];
const finished = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Added a retry to the fetch helper.',
  modelUsage: { 'claude-opus-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 7, costUSD: 0.5 } },
  permission_denials: [],
};
/* eslint-enable @typescript-eslint/naming-convention */

describe('SdkAgent', () => {
  it('should hand the SDK the ticket as the prompt, in the clone it was given.', async () => {
    const runQuery = fakeQuery([...wroteAFile, finished]);

    await new SdkAgent(settings, runQuery).run(request);

    expect(runQuery.calls[0]?.prompt).toContain('MAPCO-11434');
    expect(runQuery.calls[0]?.prompt).toContain('The helper gives up on the first 503.');
    expect(runQuery.calls[0]?.options.cwd).toBe('/workspace/raster-shared');
    expect(runQuery.calls[0]?.options.maxTurns).toBe(9);
  });

  it('should hand the SDK the restricted tool surface, unmodified.', async () => {
    // The acceptance criterion the whole ticket turns on. `buildAgentOptions` deciding the
    // right list is worth nothing if the list the SDK receives is a different one.
    const runQuery = fakeQuery([...wroteAFile, finished]);

    await new SdkAgent(settings, runQuery).run(request);

    const options = runQuery.calls[0]?.options;

    expect(options?.tools).toStrictEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'TodoWrite']);
    expect(options?.disallowedTools).toContain('Bash');
    expect(options?.env['GITHUB_TOKEN']).toBeUndefined();
    expect(options?.env['ANTHROPIC_API_KEY']).toBe('sk-from-the-secret');
  });

  it('should read the whole stream and report what it added up to.', async () => {
    const run = await new SdkAgent(settings, fakeQuery([...wroteAFile, finished])).run(request);

    expect(run.outcome).toBe('changed');
    expect(run.usage).toStrictEqual({ input: 100, output: 20, cacheRead: 7, costUsd: 0.5 });
  });

  it('should report a stream that never produced a result as a give-up.', async () => {
    const run = await new SdkAgent(settings, fakeQuery([...wroteAFile])).run(request);

    expect(run.outcome).toBe('gave-up');
  });

  it('should run the model once per hand-off, with no session kept open between them.', async () => {
    const runQuery = fakeQuery([...wroteAFile, finished]);
    const agent = new SdkAgent(settings, runQuery);

    await agent.run(request);
    await agent.run({ ...request, previousFailure: 'AssertionError: expected 2 retries, got 1' });

    expect(runQuery.calls).toHaveLength(2);
    expect(runQuery.calls[1]?.prompt).toContain('AssertionError: expected 2 retries, got 1');
  });

  it('should refuse to be built without a key rather than failing on the first ticket.', () => {
    expect(() => new SdkAgent({ credential: { mode: 'api-key', source: 'ANTHROPIC_API_KEY', value: '  ' } }, fakeQuery([]))).toThrow(
      /ANTHROPIC_API_KEY/u
    );
  });
});
