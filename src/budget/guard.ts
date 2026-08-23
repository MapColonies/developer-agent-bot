import type { Logger } from '@map-colonies/js-logger';
import type { JiraTicket } from '../jira/types';
import type { ClaimOutcome } from '../tickets/claim';
import { createDailyCap } from './dailyCap';
import { chargeSpend, startWithinDailyCap, type ChargeOutcome } from './enforce';
import { budgetRunLine, type BudgetRunLine } from './report';
import { createTicketLedger } from './ticketLedger';
import type { AbortPort, AttemptSummary, BudgetConfig, Clock, DailyCapState, Spend } from './types';

interface BudgetGuardDeps {
  /** The configured ceilings, read from `WorkerConfig` through `budgetOf`. */
  readonly budget: BudgetConfig;
  /** How an overspent ticket is given back. Not implemented here — see `AbortPort`. */
  readonly abort: AbortPort;
  readonly logger: Logger;
  /** Injected so a test can walk a process across midnight. Defaults to the wall clock. */
  readonly clock?: Clock;
}

/**
 * The meter for the one ticket the worker is holding.
 *
 * Only obtainable from a `start` that succeeded, which is the point: a ledger cannot be charged
 * for a ticket the worker never claimed, and two tickets cannot end up sharing one.
 */
interface TicketGuard {
  /**
   * Charge spending to this ticket. A `false` outcome means stop working it — the ticket has
   * been handed back, or the log says why it could not be.
   *
   * `spent.turns` is the caller's to get right: it means model turns, so a hand-off that took
   * twelve of them charges twelve. See `TicketLedger.charge`.
   */
  charge: (spent: Spend, attempt: AttemptSummary) => Promise<ChargeOutcome>;
  /** What this ticket has cost so far. */
  spend: () => Spend;
}

/**
 * Whether the worker may work this ticket, and why not when it may not.
 *
 * `daily-cap` is the run that polled and started nothing: no Jira write happened, and the run
 * line says so. `not-claimed` is the ordinary race — a human got there first — and costs the day
 * nothing.
 */
type GuardedStart =
  | { readonly ok: true; readonly ticket: TicketGuard; readonly state: DailyCapState }
  | { readonly ok: false; readonly reason: 'daily-cap'; readonly state: DailyCapState }
  | { readonly ok: false; readonly reason: 'not-claimed'; readonly claim: Extract<ClaimOutcome, { ok: false }>; readonly state: DailyCapState };

/**
 * One cycle's worth of metering.
 *
 * Its own scope because the two counters in this slice run on different clocks: the daily
 * counter belongs to the process and has to survive every cycle, while the spend figure belongs
 * to the single "cycle complete" line it is reported on. Holding both on one object was a real
 * bug — the spend never reset, so a per-cycle field carried the process's lifetime total and the
 * second cycle looked like it had cost the first one's tokens as well. Any sum over those lines
 * would have double-counted.
 *
 * A cycle is the only way to reach `start`, so a caller cannot meter a ticket without having
 * opened the cycle the cost is attributed to — the same structural argument as a ledger per
 * ticket, one level up.
 */
interface CycleGuard {
  /** Claim and start metering a ticket, if the day still has room for one. */
  start: (ticket: JiraTicket, claim: () => Promise<ClaimOutcome>) => Promise<GuardedStart>;
  /** The budget half of the one structured "cycle complete" line, for this cycle alone. */
  runLine: () => BudgetRunLine;
}

interface BudgetGuard {
  /**
   * Open a cycle. One per `runCycle` — the spend it reports is its own, the daily counter it
   * consults is shared with every other cycle this process runs.
   */
  cycle: () => CycleGuard;
}

/**
 * Everything the worker needs to hold itself to a spend ceiling, from one config object
 * (MAPCO-11435).
 *
 * This exists so that wiring the ceilings into a cycle is one call rather than five things to
 * remember, and so the three invariants that matter are structural rather than documented: a
 * fresh ledger per ticket (cost lands on the ticket that caused it), no ledger at all for a
 * ticket the worker does not hold, and a fresh spend total per cycle (the run line reports the
 * cycle it is written on, not everything since boot).
 *
 * The lifetimes are nested and each is enforced by what hands out the next: one guard per
 * process, because the daily counter is a property of the day and the process is what spans it;
 * one cycle per run; one ledger per ticket.
 */
function createBudgetGuard(deps: BudgetGuardDeps): BudgetGuard {
  const { budget, abort, logger, clock } = deps;
  const cap = createDailyCap(budget.maxTicketsPerDay, clock);

  const openCycle = (): CycleGuard => {
    let cycleTokens = 0;
    let cycleTurns = 0;

    const meterFor = (ticket: JiraTicket): TicketGuard => {
      const ledger = createTicketLedger(budget.ticket);
      let counted: Spend = { tokens: 0, turns: 0 };

      return {
        charge: async (spent: Spend, attempt: AttemptSummary): Promise<ChargeOutcome> => {
          const outcome = await chargeSpend({ ledger, abort, logger }, ticket, spent, attempt);

          // The cycle total is taken from the ledger as a delta rather than by adding the
          // argument again, so the run line and the ticket's own comment can never disagree
          // about what a turn cost — including the turn that went over the ceiling, which is
          // still billed.
          const total = ledger.spend();
          cycleTokens += total.tokens - counted.tokens;
          cycleTurns += total.turns - counted.turns;
          counted = total;

          return outcome;
        },
        spend: (): Spend => ledger.spend(),
      };
    };

    return {
      start: async (ticket: JiraTicket, claim: () => Promise<ClaimOutcome>): Promise<GuardedStart> => {
        const attempt = await startWithinDailyCap({ cap, logger }, ticket, claim);

        if (!attempt.ok) {
          return attempt;
        }

        if (!attempt.claim.ok) {
          return { ok: false, reason: 'not-claimed', claim: attempt.claim, state: attempt.state };
        }

        return { ok: true, ticket: meterFor(ticket), state: attempt.state };
      },
      runLine: (): BudgetRunLine => budgetRunLine({ tokens: cycleTokens, turns: cycleTurns }, cap.state()),
    };
  };

  return { cycle: openCycle };
}

export { createBudgetGuard };
export type { BudgetGuard, BudgetGuardDeps, CycleGuard, GuardedStart, TicketGuard };
