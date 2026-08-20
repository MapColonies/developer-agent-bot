import { describe, expect, it } from 'vitest';
import { runCycle, type CycleDeps } from '@src/cycle';
import { FakeJira, ticket, type FakeWrite } from '@tests/helpers/fakeJira';
import { fakeLogger, type RecordedLine } from '@tests/helpers/fakeLogger';
import type { WorkerConfig } from '@src/common/workerConfig';
import type { JiraTransition } from '@src/jira/types';

const BOT_ACCOUNT = 'developer-agent@mapcolonies.example';
const BOT_DISPLAY_NAME = 'AGENT DEVELOPER';

const baseConfig: WorkerConfig = {
  pollIntervalMs: 1000,
  maxTicketsPerRun: 1,
  maxConcurrentTickets: 1,
  mcpUrl: 'http://mcp.invalid',
  bot: { account: BOT_ACCOUNT, displayName: BOT_DISPLAY_NAME },
};

const displayNames = { [BOT_ACCOUNT]: BOT_DISPLAY_NAME };

/** A realistic workflow: transitions named as verbs, each reporting the status it lands in. */
function workflowFor(...keys: string[]): Record<string, JiraTransition[]> {
  return Object.fromEntries(
    keys.map((key) => [
      key,
      [
        { id: '21', name: 'Start Progress', to: 'In Progress' },
        { id: '11', name: 'Reopen', to: 'Open' },
      ],
    ])
  );
}

function makeCycle(jira: FakeJira, overrides: Partial<WorkerConfig> = {}): { deps: CycleDeps; lines: RecordedLine[] } {
  const { logger, lines } = fakeLogger();

  return { deps: { jira, logger, config: { ...baseConfig, ...overrides } }, lines };
}

function kindsOf(writes: FakeWrite[]): string[] {
  return writes.map((write) => write.kind);
}

/** The order tickets appear in the write log, collapsed — `[a, b]` means a finished before b started. */
function ticketRuns(writes: FakeWrite[]): string[] {
  return writes.map((write) => write.key).filter((key, index, keys) => key !== keys[index - 1]);
}

describe('runCycle', () => {
  it('should claim the ticket it found and hand it straight back.', async () => {
    const jira = new FakeJira({ tickets: [ticket({ key: 'MAPCO-100' })], transitions: workflowFor('MAPCO-100'), displayNames });
    const { deps, lines } = makeCycle(jira);

    const result = await runCycle(deps);

    expect(result).toMatchObject({ found: 1, started: 1, skipped: 0, outcome: 'ok' });
    expect(jira.writes).toEqual([
      { kind: 'assign', key: 'MAPCO-100', assignee: BOT_ACCOUNT },
      { kind: 'transition', key: 'MAPCO-100', transitionId: '21' },
      { kind: 'comment', key: 'MAPCO-100', body: expect.stringContaining('MAPCO-11431') as unknown as string },
      { kind: 'transition', key: 'MAPCO-100', transitionId: '11' },
      { kind: 'assign', key: 'MAPCO-100', assignee: null },
    ]);
    expect(lines.at(-1)?.payload).toMatchObject({ found: 1, started: 1, keys: ['MAPCO-100'] });
  });

  it('should leave the ticket unassigned again, so the next run can pick it up.', async () => {
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflowFor('MAPCO-1'), displayNames });
    const { deps } = makeCycle(jira);

    await runCycle(deps);

    await expect(jira.getIssue('MAPCO-1')).resolves.toMatchObject({ assignee: null });
  });

  it('should not touch a ticket that turns out to be assigned by the time it is reached.', async () => {
    // The poll query filters `assignee is EMPTY`, so this is the snapshot-went-stale case
    // rather than something the query would hand over — it exercises the guard before the write.
    const jira = new FakeJira({ tickets: [ticket({ assignee: 'BROCHSTEIN RAZ' })], transitions: workflowFor('MAPCO-1'), displayNames });
    const { deps } = makeCycle(jira);

    const result = await runCycle(deps);

    expect(result).toMatchObject({ found: 1, started: 0, skipped: 1 });
    expect(jira.writes).toEqual([]);
  });

  it('should back off cleanly when a human claims the ticket mid-claim.', async () => {
    const jira = new FakeJira({
      tickets: [ticket()],
      transitions: workflowFor('MAPCO-1'),
      displayNames,
      stealOnAssign: 'BROCHSTEIN RAZ',
    });
    const { deps, lines } = makeCycle(jira);

    const result = await runCycle(deps);

    expect(result).toMatchObject({ started: 0, skipped: 1, outcome: 'ok' });
    // The assign is already out there; the point is that nothing follows it — no transition,
    // no comment, and no attempt to take it back off the human.
    expect(kindsOf(jira.writes)).toEqual(['assign']);
    expect(lines.some((line) => line.level === 'warn' && line.payload.reason === 'lost-race' && line.payload.saw === 'BROCHSTEIN RAZ')).toBe(true);
  });

  it('should report the transitions a workflow did offer when it cannot claim.', async () => {
    // The real transition vocabulary is unverified, so a refusal has to say what it saw
    // rather than leaving a silent no-op to be discovered by a drained queue.
    const jira = new FakeJira({ tickets: [ticket()], transitions: { 'MAPCO-1': [{ id: '31', name: 'Reject', to: 'Rejected' }] }, displayNames });
    const { deps, lines } = makeCycle(jira);

    const result = await runCycle(deps);

    expect(result).toMatchObject({ started: 0, skipped: 1 });
    expect(lines.some((line) => line.payload.reason === 'no-transition' && (line.payload.offered as string[])[0] === 'Reject')).toBe(true);
  });

  it('should honour the per-run ticket limit and say there is more waiting.', async () => {
    const keys = ['MAPCO-1', 'MAPCO-2', 'MAPCO-3'];
    const jira = new FakeJira({ tickets: keys.map((key) => ticket({ key })), transitions: workflowFor(...keys), displayNames });
    const { deps } = makeCycle(jira, { maxTicketsPerRun: 2, maxConcurrentTickets: 2 });

    const result = await runCycle(deps);

    expect(result.found).toBe(2);
    expect(result.started).toBe(2);
    expect(result.more).toBe(true);
    // One over the limit, because the server's `total` is always -1 and cannot be trusted.
    expect(jira.queries[0]?.limit).toBe(3);
    expect(jira.writes.some((write) => write.key === 'MAPCO-3')).toBe(false);
  });

  it('should hold tickets to one at a time at the default concurrency.', async () => {
    const keys = ['MAPCO-1', 'MAPCO-2'];
    const jira = new FakeJira({ tickets: keys.map((key) => ticket({ key })), transitions: workflowFor(...keys), displayNames });
    const { deps } = makeCycle(jira, { maxTicketsPerRun: 2, maxConcurrentTickets: 1 });

    await runCycle(deps);

    // Each ticket is finished with before the next is touched: the cap is what stops the
    // worker holding a whole page of tickets at once.
    expect(ticketRuns(jira.writes)).toEqual(['MAPCO-1', 'MAPCO-2']);
  });

  it('should overlap tickets once concurrency is raised.', async () => {
    const keys = ['MAPCO-1', 'MAPCO-2'];
    const jira = new FakeJira({ tickets: keys.map((key) => ticket({ key })), transitions: workflowFor(...keys), displayNames });
    const { deps } = makeCycle(jira, { maxTicketsPerRun: 2, maxConcurrentTickets: 2 });

    await runCycle(deps);

    // Interleaved rather than one-then-the-other, which is the difference the cap makes.
    expect(ticketRuns(jira.writes).length).toBeGreaterThan(2);
  });

  it('should not claim there is more waiting when the queue is exhausted.', async () => {
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflowFor('MAPCO-1'), displayNames });
    const { deps } = makeCycle(jira);

    expect((await runCycle(deps)).more).toBe(false);
  });

  it('should report an empty queue rather than treating it as a failure.', async () => {
    const jira = new FakeJira({ tickets: [] });
    const { deps, lines } = makeCycle(jira);

    const result = await runCycle(deps);

    expect(result).toMatchObject({ found: 0, started: 0, outcome: 'ok' });
    expect(lines[0]?.level).toBe('info');
  });

  it('should survive a poll failure and report it, so the schedule keeps running.', async () => {
    const jira = new FakeJira({ failWith: new Error('mcp unreachable') });
    const { deps, lines } = makeCycle(jira);

    const result = await runCycle(deps);

    expect(result.outcome).toBe('failed');
    expect(lines[0]?.level).toBe('error');
  });

  it('should keep hold of a ticket it cannot return to Open, and say so loudly.', async () => {
    const jira = new FakeJira({
      tickets: [ticket()],
      transitions: { 'MAPCO-1': [{ id: '21', name: 'Start Progress', to: 'In Progress' }] },
      displayNames,
    });
    const { deps, lines } = makeCycle(jira);

    const result = await runCycle(deps);

    // It did hold the ticket, so it counts as started — but it is now stuck, and the run
    // line has to make that findable.
    expect(result).toMatchObject({ started: 1, outcome: 'ok' });
    await expect(jira.getIssue('MAPCO-1')).resolves.toMatchObject({ assignee: BOT_DISPLAY_NAME });
    expect(lines.some((line) => line.level === 'error' && line.payload.msg === 'held ticket could not be released')).toBe(true);
  });

  it('should let one broken ticket fail without taking the run down with it.', async () => {
    const keys = ['MAPCO-1', 'MAPCO-2'];
    const jira = new FakeJira({ tickets: keys.map((key) => ticket({ key })), transitionsFailWith: new Error('jira exploded'), displayNames });
    const { deps, lines } = makeCycle(jira, { maxTicketsPerRun: 2 });

    const result = await runCycle(deps);

    expect(result).toMatchObject({ found: 2, started: 0, skipped: 2, outcome: 'ok' });
    expect(lines.filter((line) => line.payload.msg === 'ticket failed')).toHaveLength(2);
  });
});
