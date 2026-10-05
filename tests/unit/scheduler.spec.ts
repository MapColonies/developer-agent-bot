import type { Logger } from '@map-colonies/js-logger';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createBudgetGuard } from '@src/budget/guard';
import type { AbortResult } from '@src/budget/types';
import type { CycleDeps } from '@src/cycle';
import type { DeliveryOutcome, DeliveryPort } from '@src/deliver';
import { createScheduler } from '@src/scheduler';
import { createHandBackOnce, type HandBackOnce } from '@src/tickets/handBackOnce';
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
  workspaceRoot: '/workspace',
  commitIdentity: { name: 'developer-agent[bot]', email: 'developer-agent[bot]@users.noreply.github.com' },
};

/**
 * Delivery that does nothing, because these cases are about the clock.
 *
 * What one claimed ticket costs is `runCycle`'s business and is covered through that seam
 * (tests/integration/cycle.spec.ts); what is being asserted here is that a cycle runs, runs
 * again after the interval, and stops when told — which a pipeline standing behind it would only
 * make slower to read.
 */
const delivery: DeliveryPort = {
  deliver: async (): Promise<DeliveryOutcome> => Promise.resolve({ ok: false, reason: 'no-repo', handedBack: true }),
};

function cycleDeps(jira: FakeJira, logger: Logger): CycleDeps {
  const handBackDeps = { jira, logger, attemptCap: 2 };

  return {
    jira,
    logger,
    config,
    delivery,
    budget: createBudgetGuard({
      budget: { ticket: { maxTokens: 1_000, maxTurns: 10 }, maxTicketsPerDay: 100 },
      abort: { abort: async (): Promise<AbortResult> => Promise.resolve({ released: true, attemptCounted: true }) },
      logger,
    }),
    handBack: (): HandBackOnce => createHandBackOnce(handBackDeps),
  };
}

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
    const scheduler = createScheduler(cycleDeps(jira, logger), 1000, logger);

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
    const scheduler = createScheduler(cycleDeps(jira, logger), 1000, logger);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(jira.queries).toHaveLength(2);

    await scheduler.stop();
  });

  it('should stop scheduling once stopped.', async () => {
    const jira = new FakeJira({ tickets: [] });
    const { logger } = fakeLogger();
    const scheduler = createScheduler(cycleDeps(jira, logger), 1000, logger);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.stop();

    await vi.advanceTimersByTimeAsync(5000);

    expect(jira.queries).toHaveLength(1);
  });
});
