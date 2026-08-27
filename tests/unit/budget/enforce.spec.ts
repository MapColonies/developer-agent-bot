import { describe, expect, it } from 'vitest';
import { countAttempt } from '@src/budget/attempt';
import { createDailyCap } from '@src/budget/dailyCap';
import { chargeSpend, startWithinDailyCap } from '@src/budget/enforce';
import { createTicketLedger } from '@src/budget/ticketLedger';
import { claimTicket, releaseTicket } from '@src/tickets/claim';
import { FakeJira, ticket } from '@tests/helpers/fakeJira';
import { fakeLogger } from '@tests/helpers/fakeLogger';
import type { AbortPort, AbortResult, AttemptSummary } from '@src/budget/types';
import type { JiraPort, JiraTicket } from '@src/jira/types';
import type { BotIdentity } from '@src/tickets/claim';

const BOT_ACCOUNT = 'developer-agent@mapcolonies.example';
const BOT_DISPLAY_NAME = 'AGENT DEVELOPER';

const bot: BotIdentity = { account: BOT_ACCOUNT, displayName: BOT_DISPLAY_NAME };
const displayNames = { [BOT_ACCOUNT]: BOT_DISPLAY_NAME };

/** A realistic workflow: transitions named as verbs, each reporting the status it lands in. */
const workflow = {
  'MAPCO-1': [
    { id: '21', name: 'Start Progress', to: 'In Progress' },
    { id: '11', name: 'Reopen', to: 'Open' },
  ],
};

const NOON = Date.UTC(2026, 7, 20, 12);
const MS_PER_HOUR = 3_600_000;

const attempt: AttemptSummary = { tried: ['read the ticket', 'cloned the repo'], reached: 'branch pushed, no pull request' };

/**
 * The attempt cap the poll query is built with, restated rather than imported from `src/cycle`.
 *
 * `countAttempt` takes the cap as an argument precisely so the budget module does not depend on
 * the cycle seam, and a test that imported the constant would put that dependency back.
 */
const ATTEMPT_CAP = 2;

/** A ticket the worker is already holding, which is the only state a budget can run out in. */
function held(): JiraTicket {
  return ticket({ assignee: BOT_DISPLAY_NAME, status: 'In Progress' });
}

/**
 * Records the abort instead of performing it.
 *
 * Used for the cases about the *contract* — that one exhaustion aborts exactly once, that a
 * rejection is contained, that a partial hand-back is reported. `handBackThrough` below drives
 * the real release path instead, for the cases about where the ticket actually ends up.
 *
 * It reports a fully successful hand-back by default. `managed` overrides that, because the
 * partial outcomes are the interesting ones: today's `JiraPort` has no label write, so a real
 * implementation would report `attemptCounted: false`.
 */
function fakeAbort(failWith?: Error, managed?: AbortResult): AbortPort & { aborted: { key: string; note: string }[] } {
  const aborted: { key: string; note: string }[] = [];

  return {
    aborted,
    abort: async (target: JiraTicket, note: string): Promise<AbortResult> => {
      aborted.push({ key: target.key, note });

      return failWith === undefined ? Promise.resolve(managed ?? { released: true, attemptCounted: true }) : Promise.reject(failWith);
    },
  };
}

describe('chargeSpend', () => {
  it('should let a ticket carry on while it still has budget, leaving the abort path alone.', async () => {
    const abort = fakeAbort();
    const { logger } = fakeLogger();
    const deps = { ledger: createTicketLedger({ maxTokens: 1000, maxTurns: 10 }), abort, logger };

    await expect(chargeSpend(deps, held(), { tokens: 100, turns: 1 }, attempt)).resolves.toEqual({ ok: true, spend: { tokens: 100, turns: 1 } });
    expect(abort.aborted).toEqual([]);
  });

  it('should take the release path when the budget runs out mid-ticket, rather than throwing.', async () => {
    const abort = fakeAbort();
    const { logger } = fakeLogger();
    const deps = { ledger: createTicketLedger({ maxTokens: 1000, maxTurns: 10 }), abort, logger };

    await chargeSpend(deps, held(), { tokens: 400, turns: 1 }, attempt);
    const outcome = await chargeSpend(deps, held(), { tokens: 900, turns: 1 }, attempt);

    // Going over is an outcome, not an exception: the caller is told to stop and the ticket is
    // handed back. A throw here would surface as `ticket failed` in the run, indistinguishable
    // from a bug, and would leave the money spent with nothing on the ticket to show for it.
    expect(outcome).toEqual({
      ok: false,
      alreadyStopped: false,
      released: true,
      attemptCounted: true,
      overspend: { kind: 'tokens', limit: 1000, spend: { tokens: 1300, turns: 2 }, attempt },
    });
    expect(abort.aborted).toHaveLength(1);
    expect(abort.aborted[0]?.key).toBe('MAPCO-1');
  });

  it('should hand the abort path a note carrying the cost and what was tried.', async () => {
    const abort = fakeAbort();
    const { logger } = fakeLogger();
    const deps = { ledger: createTicketLedger({ maxTokens: 100, maxTurns: 10 }), abort, logger };

    await chargeSpend(deps, held(), { tokens: 1500, turns: 1 }, attempt);

    const note = abort.aborted[0]?.note ?? '';

    expect(note).toContain('1,500 tokens');
    expect(note).toContain('100 tokens per ticket');
    expect(note).toContain('- cloned the repo');
    expect(note).toContain('branch pushed, no pull request');
  });

  it('should put the per-ticket cost in the log as well as on the ticket.', async () => {
    const { logger, lines } = fakeLogger();
    const deps = { ledger: createTicketLedger({ maxTokens: 100, maxTurns: 10 }), abort: fakeAbort(), logger };

    await chargeSpend(deps, held(), { tokens: 1500, turns: 1 }, attempt);

    expect(lines).toContainEqual({
      level: 'warn',
      payload: { msg: 'budget exhausted', key: 'MAPCO-1', kind: 'tokens', limit: 100, tokensSpent: 1500, turnsSpent: 1 },
    });
  });

  it('should keep holding a ticket whose hand-back failed, and say so instead of crashing.', async () => {
    const abort = fakeAbort(new Error('MCP unreachable'));
    const { logger, lines } = fakeLogger();
    const deps = { ledger: createTicketLedger({ maxTokens: 100, maxTurns: 10 }), abort, logger };

    const outcome = await chargeSpend(deps, held(), { tokens: 1500, turns: 1 }, attempt);

    // Held-and-stuck is the recoverable state: the poll query skips a ticket assigned to the
    // bot, and the boot-time orphan sweep (MAPCO-11432) is what gets it back. `released: false`
    // is how the caller knows not to try to hand it back a second time.
    expect(outcome).toMatchObject({ ok: false, released: false, attemptCounted: false });
    expect(lines).toContainEqual({
      level: 'error',
      payload: { msg: 'overspent ticket could not be handed back', key: 'MAPCO-1', err: new Error('MCP unreachable') },
    });
  });

  it('should hand a ticket back once however many times it is charged afterwards.', async () => {
    const abort = fakeAbort();
    const { logger } = fakeLogger();
    const deps = { ledger: createTicketLedger({ maxTokens: 100, maxTurns: 10 }), abort, logger };
    const ticketHeld = held();

    await chargeSpend(deps, ticketHeld, { tokens: 1500, turns: 1 }, attempt);
    const second = await chargeSpend(deps, ticketHeld, { tokens: 200, turns: 1 }, attempt);
    const third = await chargeSpend(deps, ticketHeld, { tokens: 200, turns: 1 }, attempt);

    // A caller can charge again for honest reasons — a turn was in flight when the last one
    // refused, or it read a failed hand-back as retryable. A second comment on a ticket already
    // back in Open, and a second unassign of one a human may have picked up in between, is not
    // something the caller should have to be careful about.
    expect(abort.aborted).toHaveLength(1);
    expect(second).toMatchObject({ ok: false, alreadyStopped: true });
    expect(third).toMatchObject({ ok: false, alreadyStopped: true });
  });

  it('should keep billing the turns charged after the budget went, so the run line stays honest.', async () => {
    const { logger, lines } = fakeLogger();
    const deps = { ledger: createTicketLedger({ maxTokens: 100, maxTurns: 10 }), abort: fakeAbort(), logger };

    await chargeSpend(deps, held(), { tokens: 1500, turns: 1 }, attempt);
    const second = await chargeSpend(deps, held(), { tokens: 500, turns: 1 }, attempt);

    expect(second).toMatchObject({ overspend: { spend: { tokens: 2000, turns: 2 } } });
    expect(lines).toContainEqual({
      level: 'warn',
      payload: { msg: 'charged spending to a ticket that had already run out of budget', key: 'MAPCO-1', tokensSpent: 2000, turnsSpent: 2 },
    });
  });

  it('should say loudly when an overspent ticket went back without its attempt being counted.', async () => {
    const abort = fakeAbort(undefined, { released: true, attemptCounted: false });
    const { logger, lines } = fakeLogger();
    const deps = { ledger: createTicketLedger({ maxTokens: 100, maxTurns: 10 }), abort, logger };

    const outcome = await chargeSpend(deps, held(), { tokens: 1500, turns: 1 }, attempt);

    // The failure this reports is the runaway the slice exists to bound: an uncounted overspend
    // still matches the poll query, so the same ticket comes back next cycle and burns the same
    // budget again. Nothing in the worker can bump the label yet (MAPCO-11432), so the comment
    // on the ticket must not claim it did — and the log must not be silent about it either.
    expect(outcome).toMatchObject({ ok: false, released: true, attemptCounted: false });
    expect(abort.aborted[0]?.note ?? '').not.toContain('counting the attempt');
    expect(lines).toContainEqual({
      level: 'warn',
      payload: { msg: 'overspent ticket was not fully handed back', key: 'MAPCO-1', released: true, attemptCounted: false },
    });
  });
});

describe('startWithinDailyCap', () => {
  it('should claim a ticket while the day still has room, and count it as started.', async () => {
    const cap = createDailyCap(2, () => NOON);
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflow, displayNames });
    const { logger } = fakeLogger();

    const outcome = await startWithinDailyCap({ cap, logger }, ticket(), async () => claimTicket(ticket(), jira, bot));

    expect(outcome).toEqual({ ok: true, claim: { ok: true }, state: { startedToday: 1, limit: 2, exhausted: false } });
    expect(jira.writes).toEqual([
      { kind: 'assign', key: 'MAPCO-1', assignee: BOT_ACCOUNT },
      { kind: 'transition', key: 'MAPCO-1', transitionId: '21' },
    ]);
  });

  it('should stop a ticket being claimed at all once the daily cap is hit.', async () => {
    const cap = createDailyCap(1, () => NOON);
    cap.recordStart();
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflow, displayNames });
    const { logger, lines } = fakeLogger();

    const outcome = await startWithinDailyCap({ cap, logger }, ticket(), async () => claimTicket(ticket(), jira, bot));

    expect(outcome).toEqual({ ok: false, reason: 'daily-cap', state: { startedToday: 1, limit: 1, exhausted: true } });
    // Not one write reached Jira: a ticket claimed and then dropped for a spend ceiling has
    // already put a bot's name on a human's ticket and notified everyone watching it.
    expect(jira.writes).toEqual([]);
    expect(lines).toContainEqual({
      level: 'info',
      payload: { msg: 'daily cap reached, starting nothing', key: 'MAPCO-1', startedToday: 1, limit: 1 },
    });
  });

  it('should not spend a day slot on a ticket a human won.', async () => {
    const cap = createDailyCap(1, () => NOON);
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflow, displayNames, stealOnAssign: 'BROCHSTEIN RAZ' });
    const { logger } = fakeLogger();

    const outcome = await startWithinDailyCap({ cap, logger }, ticket(), async () => claimTicket(ticket(), jira, bot));

    // The counter bounds tickets the worker *worked*. A lost race spends nothing, and paying a
    // day's allowance for one would idle the worker until midnight over other people's tickets.
    expect(outcome).toMatchObject({ ok: true, claim: { ok: false, reason: 'lost-race' } });
    expect(cap.state()).toStrictEqual({ startedToday: 0, limit: 1, exhausted: false });
  });

  it('should start tickets again once the day has turned over.', async () => {
    let now = NOON;
    const cap = createDailyCap(1, () => now);
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflow, displayNames });
    const { logger } = fakeLogger();
    const claim = async (): ReturnType<typeof claimTicket> => claimTicket(ticket(), jira, bot);

    await startWithinDailyCap({ cap, logger }, ticket(), claim);

    await expect(startWithinDailyCap({ cap, logger }, ticket(), claim)).resolves.toMatchObject({ ok: false, reason: 'daily-cap' });

    now = NOON + 13 * MS_PER_HOUR;

    await expect(startWithinDailyCap({ cap, logger }, ticket(), claim)).resolves.toMatchObject({ ok: true });
  });
});

/**
 * An `AbortPort` built out of the pieces that exist today, so the seam tests below prove where an
 * overspent ticket really ends up rather than that a recorder was called.
 *
 * It is a *test* fixture on purpose. A production implementation of this port is MAPCO-11431's:
 * this slice must not grow a second copy of the release path, whose ordering — comment, then
 * transition to Open, then unassign last — is load-bearing and already correct in one place.
 * What these tests pin is that the budget module hands that path the right note at the right
 * moment and reads its outcome honestly.
 *
 * `attemptCounted` is `false` and not a shortcut: `countAttempt` says exactly which labels would
 * count the attempt, and `JiraPort` has no label write to put them anywhere.
 */
function handBackThrough(jira: JiraPort): AbortPort & { wouldLabel: (readonly string[])[] } {
  const wouldLabel: (readonly string[])[] = [];

  return {
    wouldLabel,
    abort: async (target: JiraTicket, note: string): Promise<AbortResult> => {
      const release = await releaseTicket(target, note, jira);

      wouldLabel.push(countAttempt(target.labels, ATTEMPT_CAP));

      return { released: release.ok, attemptCounted: false };
    },
  };
}

describe('chargeSpend against the real release path', () => {
  it('should leave an overspent ticket back in Open and unassigned, with the spend on it.', async () => {
    const jira = new FakeJira({ tickets: [held()], transitions: workflow, displayNames });
    const abort = handBackThrough(jira);
    const { logger } = fakeLogger();
    const deps = { ledger: createTicketLedger({ maxTokens: 100, maxTurns: 10 }), abort, logger };

    const outcome = await chargeSpend(deps, held(), { tokens: 1500, turns: 3 }, attempt);

    // The ticket's own Expected Result, end to end through `releaseTicket`: the comment goes on
    // first, the transition back to Open second, and the unassign *last* — because unassigning
    // is what puts the ticket in front of the poll query again, so a part-way failure must leave
    // it held rather than unassigned-and-In-Progress.
    const first = jira.writes[0];

    expect(outcome).toMatchObject({ ok: false, released: true });
    expect(jira.writes.map((write) => write.kind)).toEqual(['comment', 'transition', 'assign']);
    expect(jira.writes.slice(1)).toEqual([
      { kind: 'transition', key: 'MAPCO-1', transitionId: '11' },
      { kind: 'assign', key: 'MAPCO-1', assignee: null },
    ]);

    // The cost lands on the ticket that caused it: the comment Jira actually received is the one
    // carrying the spend, not a note composed and then dropped somewhere in the hand-back.
    expect(first?.kind === 'comment' ? first.body : '').toContain('3 turns and 1,500 tokens');
    await expect(jira.getIssue('MAPCO-1')).resolves.toMatchObject({ assignee: null, labels: ['agent-ready'] });
  });

  it('should keep holding an overspent ticket its workflow cannot get back to Open.', async () => {
    const jira = new FakeJira({
      tickets: [held()],
      transitions: { 'MAPCO-1': [{ id: '21', name: 'Start Progress', to: 'In Progress' }] },
      displayNames,
    });
    const abort = handBackThrough(jira);
    const { logger, lines } = fakeLogger();
    const deps = { ledger: createTicketLedger({ maxTokens: 100, maxTurns: 10 }), abort, logger };

    const outcome = await chargeSpend(deps, held(), { tokens: 1500, turns: 1 }, attempt);

    // `releaseTicket` refuses to unassign a ticket it cannot move to Open: held-and-stuck is
    // recoverable by the boot-time orphan sweep (MAPCO-11432), unassigned-and-stuck polls
    // straight back in forever. The budget module reports that rather than retrying it.
    expect(outcome).toMatchObject({ ok: false, released: false });
    expect(jira.writes.filter((write) => write.kind === 'assign')).toEqual([]);
    expect(lines).toContainEqual({
      level: 'warn',
      payload: { msg: 'overspent ticket was not fully handed back', key: 'MAPCO-1', released: false, attemptCounted: false },
    });
  });

  it('should hand the ticket back without counting the attempt, since no label write exists.', async () => {
    const jira = new FakeJira({ tickets: [held()], transitions: workflow, displayNames });
    const abort = handBackThrough(jira);
    const { logger } = fakeLogger();
    const deps = { ledger: createTicketLedger({ maxTokens: 100, maxTurns: 10 }), abort, logger };

    await chargeSpend(deps, held(), { tokens: 1500, turns: 1 }, attempt);

    // The runaway this slice exists to bound, pinned as the open gap it is. `countAttempt` knows
    // the labels that would take the ticket out of the poll query; `JiraPort` has `assign`,
    // `transition` and `addComment` and nothing that can write them, so every write below is a
    // non-label one and the ticket goes back to Open still matching `buildPollQuery`.
    expect(abort.wouldLabel).toEqual([['agent-ready', 'agent-attempted-1']]);
    expect(jira.writes.map((write) => write.kind)).toEqual(['comment', 'transition', 'assign']);
  });
});
