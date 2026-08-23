import type { Logger } from '@map-colonies/js-logger';
import type { JiraTicket } from '../jira/types';
import type { ClaimOutcome } from '../tickets/claim';
import { describeOverspend } from './report';
import type { AbortPort, AttemptSummary, DailyCap, DailyCapState, Overspend, Spend, TicketLedger } from './types';

interface BudgetDeps {
  readonly ledger: TicketLedger;
  readonly abort: AbortPort;
  readonly logger: Logger;
}

interface DailyCapDeps {
  readonly cap: DailyCap;
  readonly logger: Logger;
}

/**
 * Whether the ticket may take another turn, and — when it may not — what the abort path
 * actually managed.
 *
 * `released: false` means the ticket is still assigned to the bot and still In Progress. That
 * is the same containment `releaseTicket` chooses on a stuck workflow: the poll query skips a
 * ticket held by the bot, and the boot-time orphan sweep (MAPCO-11432) is what recovers it. A
 * caller that sees it must stop working the ticket and must not release it a second time.
 *
 * `alreadyStopped: true` is the answer to a charge made after the budget had already run out.
 * Nothing was written for it — the ticket was handed back by the charge that first refused —
 * and there is nothing for the caller to do beyond stop, which it should already have done.
 */
type ChargeOutcome =
  | { readonly ok: true; readonly spend: Spend }
  | {
      readonly ok: false;
      readonly alreadyStopped: false;
      readonly overspend: Overspend;
      readonly released: boolean;
      /** Whether the hand-back counted the attempt. See `AbortResult.attemptCounted`. */
      readonly attemptCounted: boolean;
    }
  | { readonly ok: false; readonly alreadyStopped: true; readonly overspend: Overspend };

/** Whether the day had room for this ticket, and what the claim said if it did. */
type StartAttempt =
  | { readonly ok: true; readonly claim: ClaimOutcome; readonly state: DailyCapState }
  | { readonly ok: false; readonly reason: 'daily-cap'; readonly state: DailyCapState };

/**
 * Charge spending to a ticket and, if that used the budget up, abort the ticket (MAPCO-11435).
 *
 * `spent` carries both halves because the caller is the only thing that knows them. A caller
 * handed one usage figure for a whole hand-off charges that hand-off's real turn count, not `1`
 * — see `TicketLedger.charge` for why the difference is a factor of `MAX_TURNS_PER_TICKET`.
 *
 * Going over is an outcome, not an exception: this never rejects, whatever the abort path does.
 * A ticket that ran out of money is an ordinary day for the worker, and a throw here would
 * surface as `ticket failed` in the run — indistinguishable from a bug, and one line of log
 * instead of a comment on the ticket that spent the money.
 *
 * The hand-back happens at most once per ticket, guaranteed by the ledger's latch rather than
 * by asking callers to stop: a second call after the budget has gone charges the money and
 * writes nothing.
 */
async function chargeSpend(deps: BudgetDeps, ticket: JiraTicket, spent: Spend, attempt: AttemptSummary): Promise<ChargeOutcome> {
  const { ledger, abort, logger } = deps;
  const check = ledger.charge(spent);

  if (check.ok) {
    return { ok: true, spend: check.spend };
  }

  const overspend: Overspend = { kind: check.kind, limit: check.limit, spend: check.spend, attempt };

  if (check.alreadyStopped) {
    // Worth a line, because it means a caller kept spending after being told to stop, but not
    // worth a second comment on a ticket somebody else may already have picked up.
    logger.warn({
      msg: 'charged spending to a ticket that had already run out of budget',
      key: ticket.key,
      tokensSpent: overspend.spend.tokens,
      turnsSpent: overspend.spend.turns,
    });

    return { ok: false, alreadyStopped: true, overspend };
  }

  logger.warn({
    msg: 'budget exhausted',
    key: ticket.key,
    kind: overspend.kind,
    limit: overspend.limit,
    tokensSpent: overspend.spend.tokens,
    turnsSpent: overspend.spend.turns,
  });

  try {
    const result = await abort.abort(ticket, describeOverspend(overspend));

    // A hand-back that returned but did not finish the job is the quiet failure mode: an
    // unreleased ticket sits held until the orphan sweep, and an *uncounted* one goes straight
    // back into the poll query and spends the same budget again next cycle. Neither shows up
    // anywhere else, so it goes in the log next to what it cost.
    if (!result.released || !result.attemptCounted) {
      logger.warn({
        msg: 'overspent ticket was not fully handed back',
        key: ticket.key,
        released: result.released,
        attemptCounted: result.attemptCounted,
      });
    }

    return { ok: false, alreadyStopped: false, overspend, released: result.released, attemptCounted: result.attemptCounted };
  } catch (error) {
    logger.error({ msg: 'overspent ticket could not be handed back', key: ticket.key, err: error });

    return { ok: false, alreadyStopped: false, overspend, released: false, attemptCounted: false };
  }
}

/**
 * Start a ticket only if the day still has room for one (MAPCO-11435).
 *
 * The claim arrives as a callback rather than being done here, for two reasons. A run that has
 * hit the cap must write nothing at all: a ticket claimed and then dropped for a spend ceiling
 * has already put a bot's name on a human's ticket and notified its watchers, and "poll and
 * start nothing" has to mean nothing. And the count must not drift apart from the claim it
 * counts, which it would the moment a caller could do one without the other.
 *
 * The state returned is read *after* the claim, so it already includes the ticket just started
 * and can go straight into the run line.
 */
async function startWithinDailyCap(deps: DailyCapDeps, ticket: JiraTicket, claim: () => Promise<ClaimOutcome>): Promise<StartAttempt> {
  const { cap, logger } = deps;
  const before = cap.state();

  if (before.exhausted) {
    // Not a warning: this is the ceiling doing its job, and the run line says so too.
    logger.info({ msg: 'daily cap reached, starting nothing', key: ticket.key, startedToday: before.startedToday, limit: before.limit });

    return { ok: false, reason: 'daily-cap', state: before };
  }

  const outcome = await claim();

  // Counted only once the worker actually holds the ticket — a claim lost to a human spends
  // nothing, and paying a day's allowance for a race would idle the worker until midnight.
  if (outcome.ok) {
    cap.recordStart();
  }

  return { ok: true, claim: outcome, state: cap.state() };
}

export { chargeSpend, startWithinDailyCap };
export type { BudgetDeps, ChargeOutcome, DailyCapDeps, StartAttempt };
