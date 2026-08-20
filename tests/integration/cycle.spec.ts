import { describe, expect, it } from 'vitest';
import { runCycle, type CycleDeps } from '@src/cycle';
import { FakeJira, ticket } from '@tests/helpers/fakeJira';
import { fakeLogger, type RecordedLine } from '@tests/helpers/fakeLogger';
import type { WorkerConfig } from '@src/common/workerConfig';

const baseConfig: WorkerConfig = {
  pollIntervalMs: 1000,
  maxTicketsPerRun: 1,
  maxConcurrentTickets: 1,
  mcpUrl: 'http://mcp.invalid',
};

function makeCycle(jira: FakeJira, overrides: Partial<WorkerConfig> = {}): { deps: CycleDeps; lines: RecordedLine[] } {
  const { logger, lines } = fakeLogger();

  return { deps: { jira, logger, config: { ...baseConfig, ...overrides } }, lines };
}

describe('runCycle', () => {
  it('should report what it found and that it started nothing', async () => {
    const jira = new FakeJira({ tickets: [ticket({ key: 'MAPCO-100' })] });
    const { deps, lines } = makeCycle(jira);

    const result = await runCycle(deps);

    expect(result).toMatchObject({ found: 1, started: 0, skipped: 1, outcome: 'ok' });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.payload).toMatchObject({ found: 1, started: 0, keys: ['MAPCO-100'] });
  });

  it('should write nothing to Jira.', async () => {
    const jira = new FakeJira({ tickets: [ticket()] });
    const { deps } = makeCycle(jira);

    await runCycle(deps);

    // The only thing this slice is permitted to do is ask.
    expect(jira.queries).toHaveLength(1);
  });

  it('should honour the per-run ticket limit and say there is more waiting.', async () => {
    const jira = new FakeJira({ tickets: [ticket({ key: 'MAPCO-1' }), ticket({ key: 'MAPCO-2' }), ticket({ key: 'MAPCO-3' })] });
    const { deps } = makeCycle(jira, { maxTicketsPerRun: 2 });

    const result = await runCycle(deps);

    expect(result.found).toBe(2);
    expect(result.more).toBe(true);
    // One over the limit, because the server's `total` is always -1 and cannot be trusted.
    expect(jira.queries[0]?.limit).toBe(3);
  });

  it('should not claim there is more waiting when the queue is exhausted.', async () => {
    const jira = new FakeJira({ tickets: [ticket()] });
    const { deps } = makeCycle(jira);

    expect((await runCycle(deps)).more).toBe(false);
  });

  it('should report an empty queue rather than treating it as a failure.', async () => {
    const jira = new FakeJira({ tickets: [] });
    const { deps, lines } = makeCycle(jira);

    const result = await runCycle(deps);

    expect(result).toMatchObject({ found: 0, outcome: 'ok' });
    expect(lines[0]?.level).toBe('info');
  });

  it('should survive a poll failure and report it, so the schedule keeps running.', async () => {
    const jira = new FakeJira({ failWith: new Error('mcp unreachable') });
    const { deps, lines } = makeCycle(jira);

    const result = await runCycle(deps);

    expect(result.outcome).toBe('failed');
    expect(lines[0]?.level).toBe('error');
  });
});
