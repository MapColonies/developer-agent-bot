import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createScheduler } from '@src/scheduler';
import { FakeJira, ticket } from '@tests/helpers/fakeJira';
import { fakeLogger } from '@tests/helpers/fakeLogger';
import type { WorkerConfig } from '@src/common/workerConfig';

/** A claimable ticket, so these timing tests exercise a real cycle rather than a refusal. */
const displayNames = { 'developer-agent@mapcolonies.example': 'AGENT DEVELOPER' };
const workflow = {
  'MAPCO-1': [
    { id: '21', name: 'Start Progress', to: 'In Progress' },
    { id: '11', name: 'Reopen', to: 'Open' },
  ],
};

const config: WorkerConfig = {
  pollIntervalMs: 1000,
  maxTicketsPerRun: 1,
  maxConcurrentTickets: 1,
  mcpUrl: 'http://mcp.invalid',
  bot: { account: 'developer-agent@mapcolonies.example', displayName: 'AGENT DEVELOPER' },
};

describe('createScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should run a cycle immediately and again after the interval.', async () => {
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflow, displayNames });
    const { logger } = fakeLogger();
    const scheduler = createScheduler({ jira, logger, config }, 1000, logger);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(jira.queries).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);

    expect(jira.queries).toHaveLength(2);

    await scheduler.stop();
  });

  it('should keep ticking after a failed poll rather than dying.', async () => {
    const jira = new FakeJira({ failWith: new Error('mcp unreachable') });
    const { logger } = fakeLogger();
    const scheduler = createScheduler({ jira, logger, config }, 1000, logger);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(jira.queries).toHaveLength(2);

    await scheduler.stop();
  });

  it('should stop scheduling once stopped.', async () => {
    const jira = new FakeJira({ tickets: [] });
    const { logger } = fakeLogger();
    const scheduler = createScheduler({ jira, logger, config }, 1000, logger);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.stop();

    await vi.advanceTimersByTimeAsync(5000);

    expect(jira.queries).toHaveLength(1);
  });
});
