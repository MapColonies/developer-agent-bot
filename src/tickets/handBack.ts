import type { Logger } from '@map-colonies/js-logger';
import { countAttempt } from '../budget/attempt';
import type { JiraPort, JiraTicket } from '../jira/types';
import { releaseTicket, type ReleaseOutcome } from './claim';

/**
 * Giving a ticket back and counting it against the attempt cap, as one act.
 *
 * `releaseTicket` (./claim.ts) comments, transitions to Open and unassigns. That is the whole
 * release and it is deliberately identity-free and counter-free, because a release is also what
 * happens on paths that must *not* count — the hand-straight-back in `runCycle` does no work and
 * spends nothing. This module is the other case: the worker tried, it failed or it ran out of
 * budget, and the ticket must come back carrying the fact that it was tried.
 *
 * The counter matters because it is the only thing that ends a loop. `buildPollQuery` filters on
 * `agent-ready`, an empty assignee and the label *at* the cap, so a ticket handed back without a
 * bumped counter matches the poll again on the very next tick, is claimed again, and is paid for
 * again — one ticket able to eat the whole daily allowance. `ATTEMPT_CAP` cannot express "tried
 * twice" unless something writes it down.
 *
 * Both `AbortPort` (src/budget/types.ts) and `ReleasePort` (src/agent/types.ts) are contracts for
 * exactly this, and both say the same thing: the count belongs *behind* the one call, so no path
 * can release a ticket without counting it. This is the implementation both bind to, so there is
 * one of it.
 */

interface HandBackDeps {
  readonly jira: JiraPort;
  readonly logger: Logger;
  /**
   * The cap the poll query filters on — `ATTEMPT_CAP` from src/cycle.ts.
   *
   * Passed in rather than imported so this does not depend on the cycle it is called from, and
   * because `countAttempt` clamps to it: writing a counter *past* the cap would make the ticket
   * poll-visible again, which is the opposite of counting it.
   */
  readonly attemptCap: number;
}

interface HandBackOutcome {
  /** True when the ticket is back in Open and unassigned. */
  readonly released: boolean;
  /** True when the ticket now carries a bumped `agent-attempted-N`. */
  readonly attemptCounted: boolean;
  /** Why the hand-back is incomplete, when it is. */
  readonly reason?: string;
}

/**
 * Count the attempt, then release.
 *
 * The order is the load-bearing part and it is the reverse of how it reads. Unassigning is the
 * step that makes a ticket visible to the poll again, and it is the last thing `releaseTicket`
 * does — so the counter has to be on the ticket *before* that happens. Counting afterwards leaves
 * a window in which the ticket is available and uncounted, and if the count then fails the window
 * never closes.
 *
 * So a label write that fails stops the hand-back entirely: the ticket stays held by the bot and
 * In Progress, which the poll query skips, and the boot-time orphan sweep (MAPCO-11432) is what
 * recovers it. Held-and-counted-nowhere is recoverable; available-and-uncounted is a re-burn loop.
 */
async function handBackTicket(ticket: JiraTicket, note: string, deps: HandBackDeps): Promise<HandBackOutcome> {
  const { jira, logger, attemptCap } = deps;
  const labels = countAttempt(ticket.labels, attemptCap);

  try {
    await jira.setLabels(ticket.key, labels);
  } catch (error) {
    // Loudly: this is the failure that would otherwise cost real money on every tick.
    logger.error({
      msg: 'could not count the attempt, so the ticket was not handed back',
      err: error,
      key: ticket.key,
      labels,
      reason: 'releasing an uncounted ticket would let the poll pick it up and re-burn it',
    });

    return { released: false, attemptCounted: false, reason: 'attempt-count-failed' };
  }

  const released: ReleaseOutcome = await releaseTicket(ticket, note, jira);

  if (!released.ok) {
    logger.warn({ msg: 'attempt counted but the ticket is still held', key: ticket.key, reason: released.reason, offered: released.offered });

    return { released: false, attemptCounted: true, reason: released.reason };
  }

  logger.info({ msg: 'ticket handed back', key: ticket.key, labels, attempts: labels.filter((label) => label.startsWith('agent-attempted-')) });

  return { released: true, attemptCounted: true };
}

export { handBackTicket };
export type { HandBackDeps, HandBackOutcome };
