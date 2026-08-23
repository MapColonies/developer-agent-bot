import type { JiraTicket } from '../jira/types';
import { featureTitle, ticketUrl } from '../vcs/naming';
import type { PullRequest, StagingKind, VerifiedCheck } from './types';

/**
 * What a reviewer is told about the checks.
 *
 * A tick and a cross rather than prose, because the interesting case is the mixed one: a body
 * that reads "verified locally" while one command failed is how an unverified change gets
 * merged. The list is rendered from what it was given, without filtering.
 */
const MARKS = { passed: '✅', failed: '❌' } as const;

const WHITESPACE = /\s+/gu;
/** Runs of backticks inside the text, so a code span can be delimited by one backtick more. */
const BACKTICK_RUN = /`+/gu;
/** What a summary that is nothing but whitespace is called, so the sentence still reads. */
const NO_SUMMARY = '(no summary)';

/**
 * A Jira summary, rendered so that GitHub reads it as text and not as markup.
 *
 * A summary is arbitrary prose typed by a human into a field with no rules, and GitHub turns an
 * `@handle` in a pull-request body into a notification and a subscription for that person — a
 * reviewer request in all but name, in the same body that says this pull request has requested
 * nobody. `#123`, a bare URL, `**` and a stray backtick are the same problem in smaller ways:
 * a summary that reshapes the body is a body a reviewer cannot trust.
 *
 * A code span rather than a table of backslash escapes, because GitHub's mention, issue-link,
 * autolink and emphasis extensions all stop at a code span, while `\@` is a CommonMark escape
 * that GitHub's mention pass does not reliably honour. The delimiter is one backtick longer
 * than the longest run inside the text, which is CommonMark's own rule for embedding backticks,
 * so nothing in the summary can close the span early and break out.
 *
 * Only the body needs this. A pull-request title is plain text on GitHub — it renders no
 * markdown and creates no mention — which is why `commitTitle` interpolates the summary as it is.
 */
function asText(summary: string): string {
  const flat = summary.replace(WHITESPACE, ' ').trim();

  if (flat === '') {
    return NO_SUMMARY;
  }

  const fence = '`'.repeat(Math.max(0, ...(flat.match(BACKTICK_RUN) ?? []).map((run) => run.length)) + 1);
  // CommonMark strips one leading and one trailing space from a code span, so this is how a
  // summary that itself starts or ends with a backtick still renders as what it says.
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';

  return `${fence}${pad}${flat}${pad}${fence}`;
}

interface PullRequestBodyInput {
  readonly ticket: JiraTicket;
  /** The branch the work is on, named so a reviewer can find it without opening the diff. */
  readonly branch: string;
  /** What the verify slice ran in the checkout. May be empty, and then says so. */
  readonly checks: readonly VerifiedCheck[];
  /** How the diff's file list was chosen. Required, because the answer changes what to review. */
  readonly staging: StagingKind;
}

/**
 * What the reviewer is told about how the file list was chosen.
 *
 * The unfiltered case is stated outright rather than left for someone to notice from the diff.
 * A body that describes a change as verified while quietly containing a regenerated lockfile is
 * the shape of review that gets rubber-stamped, and the fix is one sentence saying which files
 * were chosen by what.
 */
const STAGING_NOTES: Record<StagingKind, string> = {
  'agent-reported': 'Only the files the agent reported writing are in this diff; anything else the checkout produced was left uncommitted.',
  'everything-changed':
    'Every file that differed in the checkout is in this diff. The agent cannot yet report which files it wrote (MAPCO-11435), so tool output the repository does not ignore — a regenerated lockfile, for instance — may be in here too. Worth a look before approving.',
};

function renderChecks(checks: readonly VerifiedCheck[]): string[] {
  if (checks.length === 0) {
    return ['**Nothing was verified locally.** No checks were run against this change before it was pushed.'];
  }

  // The commands come from the verify slice rather than from the model, but they are rendered
  // through the same neutraliser: a body is not the place to decide which strings are trusted.
  return checks.map((check) => `- ${check.passed ? MARKS.passed : MARKS.failed} ${asText(check.command)}`);
}

/**
 * The pull request body.
 *
 * Two jobs: link the ticket, and say exactly what was and was not verified. It also says what
 * the agent cannot do — a reviewer who does not know the agent has no merge or approve
 * capability has no reason to believe the pull request is waiting for them.
 *
 * No reviewer is named and none is @-mentioned. Requesting one is not deferred by omission but
 * by decision: routing to the right human needs the ownership data MAPCO-11378 introduces, and
 * a wrong reviewer is worse than none, because it looks handled.
 */
function buildPullRequestBody(input: PullRequestBodyInput): string {
  const { ticket, branch, checks, staging } = input;

  return [
    `Written automatically by the MapColonies developer agent from [${ticket.key}](${ticketUrl(ticket.key)}) — ${asText(featureTitle(ticket.summary))}.`,
    '',
    '## Verified locally',
    '',
    ...renderChecks(checks),
    '',
    'Nothing beyond the above was checked, and nothing was deployed.',
    '',
    '## What is in this diff',
    '',
    STAGING_NOTES[staging],
    '',
    '## Review',
    '',
    `Branch \`${branch}\`. The agent can commit, push and open a pull request; it cannot merge, approve or review one, and it has requested no reviewer — a human decides all of that.`,
  ].join('\n');
}

/** What the worker says on the ticket once the pull request exists. */
function buildTicketComment(ticket: JiraTicket, branch: string, pullRequest: PullRequest): string {
  return [
    `Opened a pull request for ${ticket.key}: ${pullRequest.url}`,
    '',
    `Branch \`${branch}\`. It needs a human review — the agent cannot approve or merge it.`,
  ].join('\n');
}

export { asText, buildPullRequestBody, buildTicketComment };
export type { PullRequestBodyInput };
