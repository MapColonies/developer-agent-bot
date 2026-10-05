import { STATUS_NAMES } from '@common/constants';
import type { JiraPort, JiraTicket, JiraTransition } from '../jira/types';

/**
 * Who the worker claims tickets as.
 *
 * Two values, because Jira is asymmetric: a write takes an identifier and a read hands back
 * a display name, surname-first in this instance, and neither is derivable from the other.
 * The worker cannot ask Jira who it is — the MCP server runs under a shared service account
 * — so it has to be told both.
 */
interface BotIdentity {
  /** Written to the assignee field: an email or accountId. */
  readonly account: string;
  /** What `account` reads back as. The re-read compares against this. */
  readonly displayName: string;
}

/**
 * Why a claim or release did not happen. Each one is a normal outcome, not an error — the
 * worker moves on and the ticket stays available to whoever does hold it.
 */
type Refusal = 'already-assigned' | 'lost-race' | 'no-transition';

interface Refused {
  readonly ok: false;
  readonly reason: Refusal;
  /**
   * Who the re-read actually found, on `lost-race`. Worth reporting: if this comes back as
   * the bot's own name, the configured `displayName` is wrong rather than a human having
   * raced — a failure mode that otherwise looks identical and drains the queue silently.
   */
  readonly saw?: string | null;
  /**
   * The transition names the workflow did offer, on `no-transition`. The real vocabulary is
   * unverified (`jira_get_transitions` is not reachable from the write pilot), so the first
   * run against a real workflow needs to report what it was given.
   */
  readonly offered?: readonly string[];
}

type ClaimOutcome = { readonly ok: true } | Refused;
type ReleaseOutcome = { readonly ok: true } | Refused;

/**
 * Compare statuses the way a workflow author would, not the way a byte comparison does.
 *
 * MAPCO spells the status `In Progress` and the transition into it `Open to In-Progress`. The
 * hyphen is the kind of difference nobody intends to be meaningful, so case, hyphens,
 * underscores and runs of whitespace are all flattened before comparing.
 */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s_-]+/gu, ' ')
    .trim();
}

/**
 * The target half of a transition named `<from> to <to>`, if it has that shape.
 *
 * Non-greedy on the left so `Open to In-Progress` yields `In-Progress` rather than matching at
 * the last `to`, which would matter for a name like `Ready to Deploy to Production`.
 */
function targetInName(name: string): string | undefined {
  return /^.+?\s+to\s+(?<target>.+)$/u.exec(name)?.groups?.['target'];
}

/**
 * Find the transition that lands a ticket in `status`.
 *
 * Three strategies, narrowest first, because each is right for a different server and only the
 * first is right in general:
 *
 * 1. **Target status**, when the server reports one. The only strategy that cannot be fooled.
 * 2. **The transition's own name**, for a workflow whose transitions are named after where they
 *    land.
 * 3. **The target half of a `<from> to <to>` name.** Verified against the live MAPCO workflow,
 *    which reports no target status at all — `jira_get_transitions` answers with `id` and `name`
 *    and nothing else — and names its transitions `Open to In-Progress`, `Open to Verified`,
 *    `Open to Reject`. Without this the first two both miss and every ticket is refused with
 *    `no-transition`, which is exactly what the first real run did.
 *
 * Order matters. A transition named plainly `Open` must win over `Back to Open` if a workflow
 * somehow offers both, and strategy 3 must never outrank an exact name.
 */
function findTransition(transitions: readonly JiraTransition[], status: string): JiraTransition | undefined {
  const wanted = normalise(status);

  // Split first, because a reported target is authoritative *for that entry*: a transition
  // that says it lands in Blocked does not land in In Progress however it is named, and
  // letting a name-based guess override it would move a ticket somewhere nobody asked for.
  // The name is consulted only where there is nothing better to go on.
  const reported = transitions.filter((candidate): candidate is JiraTransition & { to: string } => candidate.to !== undefined);
  const unreported = transitions.filter((candidate) => candidate.to === undefined);

  return (
    reported.find((candidate) => normalise(candidate.to) === wanted) ??
    unreported.find((candidate) => normalise(candidate.name) === wanted) ??
    unreported.find((candidate) => {
      const target = targetInName(candidate.name);

      return target !== undefined && normalise(target) === wanted;
    })
  );
}

function refuseNoTransition(transitions: readonly JiraTransition[]): Refused {
  return { ok: false, reason: 'no-transition', offered: transitions.map((candidate) => candidate.name) };
}

/**
 * Take a ticket, optimistically.
 *
 * Jira is the only state store (MAPCO-11430), so there is no lock to take — the worker
 * writes the assignee and then asks Jira who actually holds it.
 */
async function claimTicket(ticket: JiraTicket, jira: JiraPort, bot: BotIdentity): Promise<ClaimOutcome> {
  // The poll query already filters `assignee is EMPTY`, but a search result is a snapshot
  // and this is the last look before a write. Checked here so the guard exists even when
  // the caller found the ticket some other way.
  if (ticket.assignee !== null) {
    return { ok: false, reason: 'already-assigned' };
  }

  const transitions = await jira.getTransitions(ticket.key);
  const inProgress = findTransition(transitions, STATUS_NAMES.inProgress);

  // Read before write. A workflow with no route into In Progress means this ticket can
  // never be worked, and finding that out after the assign would leave it held by a bot
  // that cannot start it.
  if (!inProgress) {
    return refuseNoTransition(transitions);
  }

  await jira.assign(ticket.key, bot.account);

  // The confirmation. Between the search and the write above, a human may have taken the
  // ticket; Jira's last write wins, so the only way to know whose name is on it is to ask.
  const confirmed = await jira.getIssue(ticket.key);
  if (confirmed?.assignee !== bot.displayName) {
    // Deliberately no unwind: if someone else's name is on the field, clearing it would
    // take the ticket off them, which is worse than leaving our write overwritten.
    return { ok: false, reason: 'lost-race', saw: confirmed?.assignee ?? null };
  }

  await jira.transition(ticket.key, inProgress.id);

  return { ok: true };
}

/**
 * Give a ticket back, saying what was tried.
 *
 * The order — comment, transition, unassign — is deliberate and is the opposite of the way
 * it reads naturally. Unassigning is the step that makes a ticket visible to the poll query
 * again (it filters `assignee is EMPTY`), so it goes last: if anything fails part-way, the
 * ticket is left held by the bot and In Progress, which the query skips, and the orphan
 * sweep on boot (MAPCO-11432) is what recovers it. Unassigning first would risk leaving a
 * ticket unassigned and In Progress — which polls straight back in, forever.
 *
 * Takes no identity: releasing is the same act whoever holds the ticket.
 */
async function releaseTicket(ticket: JiraTicket, note: string, jira: JiraPort): Promise<ReleaseOutcome> {
  await jira.addComment(ticket.key, note);

  const transitions = await jira.getTransitions(ticket.key);
  const open = findTransition(transitions, STATUS_NAMES.open);

  if (!open) {
    // Cannot get it back to Open, so do not unassign either — held-and-stuck is recoverable
    // by the orphan sweep, unassigned-and-stuck is a re-claim loop.
    return refuseNoTransition(transitions);
  }

  await jira.transition(ticket.key, open.id);
  await jira.assign(ticket.key, null);

  return { ok: true };
}

export { claimTicket, releaseTicket };
export type { BotIdentity, ClaimOutcome, Refusal, ReleaseOutcome };
