import { describe, expect, it } from 'vitest';
import { createBudgetGuard, type GuardedStart } from '@src/budget/guard';
import { budgetOf, loadWorkerConfig } from '@src/common/workerConfig';
import { claimTicket } from '@src/tickets/claim';
import { FakeJira, ticket } from '@tests/helpers/fakeJira';
import { fakeLogger } from '@tests/helpers/fakeLogger';
import type { AbortPort, AbortResult, AttemptSummary, BudgetConfig } from '@src/budget/types';
import type { JiraTicket } from '@src/jira/types';
import type { BotIdentity } from '@src/tickets/claim';

const BOT_ACCOUNT = 'developer-agent@mapcolonies.example';
const BOT_DISPLAY_NAME = 'AGENT DEVELOPER';

const bot: BotIdentity = { account: BOT_ACCOUNT, displayName: BOT_DISPLAY_NAME };
const displayNames = { [BOT_ACCOUNT]: BOT_DISPLAY_NAME };

/**
 * A realistic workflow: transitions named as verbs, each reporting the status it lands in.
 *
 * Two tickets everywhere, both claimable, so that a test asserting the *second* one was never
 * touched is proving the cap held rather than that the fake had nothing to hand over.
 */
const workflow = {
  'MAPCO-1': [
    { id: '21', name: 'Start Progress', to: 'In Progress' },
    { id: '11', name: 'Reopen', to: 'Open' },
  ],
  'MAPCO-2': [
    { id: '21', name: 'Start Progress', to: 'In Progress' },
    { id: '11', name: 'Reopen', to: 'Open' },
  ],
};

const NOON = Date.UTC(2026, 7, 20, 12);
const MS_PER_HOUR = 3_600_000;

const attempt: AttemptSummary = { tried: ['read the ticket'], reached: null };
const budget: BudgetConfig = { ticket: { maxTokens: 1000, maxTurns: 5 }, maxTicketsPerDay: 1 };

function fakeAbort(managed?: AbortResult): AbortPort & { aborted: string[] } {
  const aborted: string[] = [];

  return {
    aborted,
    abort: async (target: JiraTicket): Promise<AbortResult> => {
      aborted.push(target.key);

      return Promise.resolve(managed ?? { released: true, attemptCounted: false });
    },
  };
}

/** The guard hands out a meter only on a start that succeeded, so tests have to narrow. */
function metered(start: GuardedStart): Extract<GuardedStart, { ok: true }> {
  if (!start.ok) {
    throw new Error(`expected a started ticket, got ${start.reason}`);
  }

  return start;
}

describe('createBudgetGuard', () => {
  it('should meter a ticket it started and hand it back when the budget runs out.', async () => {
    const abort = fakeAbort();
    const { logger } = fakeLogger();
    const jira = new FakeJira({ tickets: [ticket(), ticket({ key: 'MAPCO-2' })], transitions: workflow, displayNames });
    const guard = createBudgetGuard({ budget, abort, logger, clock: () => NOON });
    const cycle = guard.cycle();

    const started = metered(await cycle.start(ticket(), async () => claimTicket(ticket(), jira, bot)));

    await expect(started.ticket.charge({ tokens: 400, turns: 1 }, attempt)).resolves.toMatchObject({ ok: true });
    await expect(started.ticket.charge({ tokens: 900, turns: 1 }, attempt)).resolves.toMatchObject({
      ok: false,
      alreadyStopped: false,
      released: true,
    });
    expect(abort.aborted).toEqual(['MAPCO-1']);
  });

  it('should start nothing and write nothing once the day is full, and say so in the run line.', async () => {
    const { logger, lines } = fakeLogger();
    const jira = new FakeJira({ tickets: [ticket(), ticket({ key: 'MAPCO-2' })], transitions: workflow, displayNames });
    const guard = createBudgetGuard({ budget, abort: fakeAbort(), logger, clock: () => NOON });
    const cycle = guard.cycle();

    await cycle.start(ticket(), async () => claimTicket(ticket(), jira, bot));
    const second = await cycle.start(ticket({ key: 'MAPCO-2' }), async () => claimTicket(ticket({ key: 'MAPCO-2' }), jira, bot));

    // One ticket a day means the second one is never claimed: no assign, no transition, nothing
    // on a human's ticket. The run line is the only alarm this service has (MAPCO-11437), so it
    // has to carry the reason the run did nothing rather than leaving it to be inferred.
    expect(second).toMatchObject({ ok: false, reason: 'daily-cap' });
    expect(jira.writes.filter((write) => write.key === 'MAPCO-2')).toEqual([]);
    expect(cycle.runLine()).toMatchObject({ ticketsStartedToday: 1, dailyCapLimit: 1, dailyCapReached: true });
    expect(lines).toContainEqual({
      level: 'info',
      payload: { msg: 'daily cap reached, starting nothing', key: 'MAPCO-2', startedToday: 1, limit: 1 },
    });
  });

  it('should add up what a run spent across every ticket it worked.', async () => {
    const { logger } = fakeLogger();
    const jira = new FakeJira({ tickets: [ticket(), ticket({ key: 'MAPCO-2' })], transitions: workflow, displayNames });
    const roomy: BudgetConfig = { ticket: { maxTokens: 10_000, maxTurns: 10 }, maxTicketsPerDay: 5 };
    let now = NOON;
    const guard = createBudgetGuard({ budget: roomy, abort: fakeAbort(), logger, clock: () => now });
    const cycle = guard.cycle();

    const first = metered(await cycle.start(ticket(), async () => claimTicket(ticket(), jira, bot)));
    await first.ticket.charge({ tokens: 300, turns: 1 }, attempt);
    await first.ticket.charge({ tokens: 200, turns: 1 }, attempt);

    const second = metered(await cycle.start(ticket({ key: 'MAPCO-2' }), async () => claimTicket(ticket({ key: 'MAPCO-2' }), jira, bot)));
    await second.ticket.charge({ tokens: 700, turns: 1 }, attempt);

    // Per-ticket cost is what the comment carries; the run total is what the run line carries,
    // and nothing but the guard is in a position to add it up.
    expect(first.ticket.spend()).toStrictEqual({ tokens: 500, turns: 2 });
    expect(second.ticket.spend()).toStrictEqual({ tokens: 700, turns: 1 });
    expect(cycle.runLine()).toMatchObject({ tokensSpent: 1200, turnsSpent: 3, ticketsStartedToday: 2 });

    now = NOON + 13 * MS_PER_HOUR;

    // The day rolls over; what the run has spent does not, because it is this run's cost.
    expect(cycle.runLine()).toMatchObject({ tokensSpent: 1200, ticketsStartedToday: 0, dailyCapReached: false });
  });

  it('should report each cycle only what that cycle spent, while the day keeps counting.', async () => {
    const { logger } = fakeLogger();
    const jira = new FakeJira({ tickets: [ticket(), ticket({ key: 'MAPCO-2' })], transitions: workflow, displayNames });
    const roomy: BudgetConfig = { ticket: { maxTokens: 10_000, maxTurns: 10 }, maxTicketsPerDay: 5 };
    const guard = createBudgetGuard({ budget: roomy, abort: fakeAbort(), logger, clock: () => NOON });

    const first = guard.cycle();
    const one = metered(await first.start(ticket(), async () => claimTicket(ticket(), jira, bot)));
    await one.ticket.charge({ tokens: 500, turns: 2 }, attempt);

    const second = guard.cycle();
    const two = metered(await second.start(ticket({ key: 'MAPCO-2' }), async () => claimTicket(ticket({ key: 'MAPCO-2' }), jira, bot)));
    await two.ticket.charge({ tokens: 300, turns: 1 }, attempt);

    // One accumulator for the whole process used to feed a per-cycle field, so the second cycle
    // reported 800 tokens for work that cost 300 and any sum over the lines double-counted. The
    // daily counter is the one thing that must carry across cycles, and still does.
    expect(first.runLine()).toMatchObject({ tokensSpent: 500, turnsSpent: 2 });
    expect(second.runLine()).toMatchObject({ tokensSpent: 300, turnsSpent: 1, ticketsStartedToday: 2 });
  });

  it('should give each ticket its own budget rather than one shared between them.', async () => {
    const { logger } = fakeLogger();
    const jira = new FakeJira({ tickets: [ticket(), ticket({ key: 'MAPCO-2' })], transitions: workflow, displayNames });
    const shareable: BudgetConfig = { ticket: { maxTokens: 1000, maxTurns: 10 }, maxTicketsPerDay: 5 };
    const guard = createBudgetGuard({ budget: shareable, abort: fakeAbort(), logger, clock: () => NOON });
    const cycle = guard.cycle();

    const first = metered(await cycle.start(ticket(), async () => claimTicket(ticket(), jira, bot)));
    await first.ticket.charge({ tokens: 900, turns: 1 }, attempt);

    const second = metered(await cycle.start(ticket({ key: 'MAPCO-2' }), async () => claimTicket(ticket({ key: 'MAPCO-2' }), jira, bot)));

    // Cost landing on the ticket that caused it is the whole point of the slice. A guard that
    // reused one ledger would stop the second ticket on the first one's spending.
    await expect(second.ticket.charge({ tokens: 50, turns: 1 }, attempt)).resolves.toEqual({ ok: true, spend: { tokens: 50, turns: 1 } });
  });

  it('should not spend a day slot, or hand out a meter, for a ticket a human won.', async () => {
    const { logger } = fakeLogger();
    const jira = new FakeJira({
      tickets: [ticket(), ticket({ key: 'MAPCO-2' })],
      transitions: workflow,
      displayNames,
      stealOnAssign: 'BROCHSTEIN RAZ',
    });
    const guard = createBudgetGuard({ budget, abort: fakeAbort(), logger, clock: () => NOON });
    const cycle = guard.cycle();

    const start = await cycle.start(ticket(), async () => claimTicket(ticket(), jira, bot));

    // No claim, no meter: a ledger for a ticket the worker does not hold is an accident waiting
    // to charge someone else's ticket. And a lost race costs the day nothing.
    expect(start).toMatchObject({ ok: false, reason: 'not-claimed', claim: { reason: 'lost-race' } });
    expect(cycle.runLine()).toMatchObject({ ticketsStartedToday: 0, dailyCapReached: false });
  });

  it('should hold itself to the ceilings the config was loaded with.', async () => {
    const { logger } = fakeLogger();
    const jira = new FakeJira({ tickets: [ticket(), ticket({ key: 'MAPCO-2' })], transitions: workflow, displayNames });
    const config = loadWorkerConfig({
      /* eslint-disable @typescript-eslint/naming-convention -- these are environment variable names */
      MCP_ATLASSIAN_URL: 'http://mcp.invalid',
      JIRA_BOT_ACCOUNT: BOT_ACCOUNT,
      JIRA_BOT_DISPLAY_NAME: BOT_DISPLAY_NAME,
      MAX_TOKENS_PER_TICKET: '100',
      MAX_TURNS_PER_TICKET: '1',
      MAX_TICKETS_PER_DAY: '1',
      /* eslint-enable @typescript-eslint/naming-convention */
    });
    const abort = fakeAbort();
    const guard = createBudgetGuard({ budget: budgetOf(config), abort, logger, clock: () => NOON });
    const cycle = guard.cycle();

    const started = metered(await cycle.start(ticket(), async () => claimTicket(ticket(), jira, bot)));

    // The ticket's own Expected Result, driven from env vars end to end: set the per-ticket
    // budget very low and the ticket comes back with a comment saying what it spent, and the
    // day is full after one ticket.
    await expect(started.ticket.charge({ tokens: 50, turns: 1 }, attempt)).resolves.toMatchObject({ ok: false, released: true });
    expect(abort.aborted).toEqual(['MAPCO-1']);
    await expect(cycle.start(ticket({ key: 'MAPCO-2' }), async () => claimTicket(ticket({ key: 'MAPCO-2' }), jira, bot))).resolves.toMatchObject({
      ok: false,
      reason: 'daily-cap',
    });
  });

  it('should hold a ticket to the configured turn ceiling however few charges it arrives in.', async () => {
    const { logger } = fakeLogger();
    const jira = new FakeJira({ tickets: [ticket(), ticket({ key: 'MAPCO-2' })], transitions: workflow, displayNames });
    const config = loadWorkerConfig({
      /* eslint-disable @typescript-eslint/naming-convention -- these are environment variable names */
      MCP_ATLASSIAN_URL: 'http://mcp.invalid',
      JIRA_BOT_ACCOUNT: BOT_ACCOUNT,
      JIRA_BOT_DISPLAY_NAME: BOT_DISPLAY_NAME,
      MAX_TURNS_PER_TICKET: '8',
      /* eslint-enable @typescript-eslint/naming-convention */
    });
    const abort = fakeAbort();
    const guard = createBudgetGuard({ budget: budgetOf(config), abort, logger, clock: () => NOON });
    const cycle = guard.cycle();

    const started = metered(await cycle.start(ticket(), async () => claimTicket(ticket(), jira, bot)));

    // An operator ramping cautiously sets MAX_TURNS_PER_TICKET=8. The spend arrives one hand-off
    // at a time, and the ceiling has to bound the *turns* inside those hand-offs rather than the
    // number of hand-offs — otherwise 8 would permit eight hand-offs of forty turns each.
    await expect(started.ticket.charge({ tokens: 900, turns: 5 }, attempt)).resolves.toMatchObject({ ok: true });
    await expect(started.ticket.charge({ tokens: 900, turns: 4 }, attempt)).resolves.toMatchObject({
      ok: false,
      overspend: { kind: 'turns', limit: 8, spend: { tokens: 1800, turns: 9 } },
    });
    expect(abort.aborted).toEqual(['MAPCO-1']);
    expect(cycle.runLine()).toMatchObject({ tokensSpent: 1800, turnsSpent: 9 });
  });
});
