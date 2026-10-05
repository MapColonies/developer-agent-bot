import type { ReleaseResult } from '../agent/types';
import type { AbortResult } from '../budget/types';
import type { JiraTicket } from '../jira/types';
import { handBackTicket, type HandBackDeps, type HandBackOutcome } from './handBack';

/**
 * One ticket's hand-back, performed at most once.
 *
 * Two independent slices each own a give-up path, and after the wiring they can both fire on the
 * same ticket in the same breath:
 *
 * - `implementTicket` (src/agent/implement.ts) funnels every give-up through one exit and calls
 *   `ReleasePort.handBack`.
 * - `chargeSpend` (src/budget/enforce.ts) calls `AbortPort.abort` on the charge that first runs
 *   the per-ticket budget out.
 *
 * Both are correct on their own, both are specified as "comment, count the attempt, release", and
 * both are bound to `handBackTicket` because their docstrings say in as many words not to write a
 * second release path. The overlap is the ordinary overspend: the budget runs out mid-hand-off,
 * the abort hands the ticket back, and the run that is now over is reported to `implementTicket`
 * as a give-up — which hands it back again. That second pass would comment a second time and
 * re-transition a ticket already in Open that a human may have picked up, which is exactly the
 * hazard `BudgetExhausted.alreadyStopped` describes and cannot itself prevent: its latch stops
 * repeated *charges*, not a different code path releasing.
 *
 * So the invariant lives here instead of in either slice, as one object per ticket in flight. The
 * ordering is always budget-then-implement — a charge only happens inside a hand-off, and the
 * give-up decision comes after it — so the overspend note is the one that lands, which is the
 * right way round: `describeOverspend` says what the ticket cost and which ceiling it hit, where
 * the give-up note would only say the run did not finish.
 */
interface HandBackOnce {
  /** `ReleasePort.handBack`: comment, count the attempt, release — unless that already happened. */
  handBack: (ticket: JiraTicket, note: string) => Promise<ReleaseResult>;
  /**
   * Record a hand-back the budget path already performed, so this one does not repeat it.
   *
   * Called by `meterAgent` with the `AbortResult` the charge reported. It latches **only if the
   * attempt was counted**, because that is the write that happens first: a result with
   * `attemptCounted: false` means `handBackTicket` refused before writing anything at all — no
   * label, no comment, no transition — so nothing has been said on the ticket and the ordinary
   * give-up path should still get its turn. Latching on that would leave a ticket held, silent
   * and uncommented, with a worker that had decided it was done with it.
   */
  record: (outcome: AbortResult) => void;
  /** Whether this ticket has been handed back, for a caller deciding what to say about it. */
  handedBack: () => boolean;
}

/** Whether a hand-back that has already happened counts as a release, in `ReleasePort`'s terms. */
function asReleaseResult(outcome: HandBackOutcome): ReleaseResult {
  return outcome.released ? { ok: true } : { ok: false, reason: outcome.reason ?? 'not-released' };
}

/**
 * The hand-back for one ticket. Build one per ticket the worker takes, and throw it away with the
 * ticket — a longer-lived one would refuse the *next* legitimate attempt on the same ticket.
 */
function createHandBackOnce(deps: HandBackDeps): HandBackOnce {
  let pending: Promise<HandBackOutcome> | null = null;

  return {
    handBack: async (ticket: JiraTicket, note: string): Promise<ReleaseResult> => {
      if (pending !== null) {
        // Worth a line: it means two give-up paths fired on one ticket, which is normal for an
        // overspend and would be worth knowing about if it ever happened for another reason.
        deps.logger.info({ msg: 'ticket already handed back, not repeating it', key: ticket.key });

        return asReleaseResult(await pending);
      }

      // Latched before the first await, so two callers racing get one write: the second joins
      // this promise rather than starting a hand-back of its own.
      pending = handBackTicket(ticket, note, deps);

      return asReleaseResult(await pending);
    },

    record: (outcome: AbortResult): void => {
      if (pending === null && outcome.attemptCounted) {
        pending = Promise.resolve({ released: outcome.released, attemptCounted: true });
      }
    },

    handedBack: (): boolean => pending !== null,
  };
}

export { createHandBackOnce };
export type { HandBackOnce };
