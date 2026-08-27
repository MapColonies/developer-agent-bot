import { LABELS } from '@common/constants';

/**
 * Counting an overspend as an attempt (MAPCO-11435).
 *
 * The attempt counter has no store but Jira labels: a ticket carries `agent-attempted-N` and
 * the poll query excludes the one *at* the cap. That makes bumping it the only thing standing
 * between an overspent ticket and being picked up next cycle and burnt for the same budget
 * again — one ticket able to eat the whole daily allowance, which is the runaway the ceilings
 * exist to bound.
 *
 * What lives here is the *policy*: given a ticket's labels, which labels count one more attempt.
 * What does not live here is the write — that is `JiraPort.setLabels`, and the one place the two
 * are put together is `handBackTicket` (src/tickets/handBack.ts), which counts before it releases
 * so a ticket cannot become pollable while still uncounted. Keeping the rule pure is what lets
 * every implementation of `AbortPort` and `ReleasePort` count the same way.
 */

/** A counter label's suffix. Anchored and digits-only, so `agent-attempted-soon` is not one. */
const COUNTER_SUFFIX = /^\d+$/u;

/**
 * The attempt this label records, or null if it is not one of the worker's counters.
 *
 * Anything under the prefix that is not a plain number is somebody else's label and is left
 * alone rather than being read as a count of zero and quietly deleted.
 */
function counterValue(label: string): number | null {
  if (!label.startsWith(LABELS.attemptedPrefix)) {
    return null;
  }

  const suffix = label.slice(LABELS.attemptedPrefix.length);

  return COUNTER_SUFFIX.test(suffix) ? Number(suffix) : null;
}

/**
 * How many attempts a ticket's labels already record. Zero when it carries no counter.
 *
 * Takes the highest rather than the count of counter labels: a ticket that somehow carries both
 * `agent-attempted-1` and `agent-attempted-2` has two attempts behind it, not three, and reading
 * it as three is how a ticket gets pushed past the cap.
 */
function attemptsSoFar(labels: readonly string[]): number {
  let highest = 0;

  for (const label of labels) {
    const counted = counterValue(label);

    if (counted !== null && counted > highest) {
      highest = counted;
    }
  }

  return highest;
}

/**
 * The labels a ticket should carry once this attempt is counted against it.
 *
 * Replaces the old counter rather than adding to it, so a ticket carries exactly one, and
 * **clamps at the cap**, which is the non-obvious half. The poll query excludes the label
 * *exactly* at `attemptCap` (`labels not in ("agent-attempted-2")`) — so writing
 * `agent-attempted-3` on a ticket already at a cap of 2 would not tighten anything, it would
 * make the ticket poll-visible again and hand it straight back to the worker forever. A ticket
 * at the cap is already invisible to the query, so leaving its counter where it is loses
 * nothing.
 *
 * Every label that is not one of the worker's counters is preserved untouched, `agent-ready`
 * included: enrolment is a human's decision and an overspend is not a reason to revoke it.
 */
function countAttempt(labels: readonly string[], attemptCap: number): readonly string[] {
  // Never below 1: a cap of zero is not a thing the query can express, and an
  // `agent-attempted-0` label would be a counter nothing ever excludes.
  const counted = Math.max(Math.min(attemptsSoFar(labels) + 1, attemptCap), 1);
  const next = `${LABELS.attemptedPrefix}${counted}`;
  const kept = labels.filter((label) => counterValue(label) === null);

  return [...kept, next];
}

export { attemptsSoFar, countAttempt };
