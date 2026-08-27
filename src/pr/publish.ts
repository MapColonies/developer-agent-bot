import type { Logger } from '@map-colonies/js-logger';
import type { Repo } from '../github/types';
import type { JiraTicket } from '../jira/types';
import { branchName, commitMessage, commitTitle } from '../vcs/naming';
import { toRepoRelative } from '../vcs/paths';
import type { GitPort } from '../vcs/types';
import { buildPullRequestBody, buildTicketComment } from './body';
import type { PullRequest, PullRequestPort, StagingKind, TicketCommentPort, VerifiedCheck } from './types';

/**
 * What a caller passes as `wrote` when the agent slice cannot say which files it wrote.
 *
 * A sentinel and not an omitted field, and not an empty array either, because the three states
 * mean different things and only one of them is safe to guess at. An empty list is "the agent
 * ran and wrote nothing", which is a refusal. This is "nobody knows", which is the state the
 * repository is actually in today: `AgentRun` (src/agent/types.ts) reports `outcome: 'changed'`
 * — a boolean — and `sdkOptions.wroteFiles()` pairs each write `tool_use` with its `tool_result`
 * only to answer yes or no, discarding every `file_path` on the way. Nothing in the tree can produce a write list, so
 * a required list would mean every ticket publishing with `[]`, refusing as
 * `nothing-the-agent-wrote`, and no pull request ever being opened.
 *
 * With the sentinel the worker commits every path git reports as changed instead. That is not
 * the same as `git add --all`: `changedFiles()` is `status --porcelain`, which never reports an
 * ignored file, so what can get swept in is limited to output a repository declines to ignore —
 * a regenerated `package-lock.json`, most often. The pull request says so in its own body and
 * the worker says so in the log, so the reviewer who has to notice is told rather than left to
 * spot it. Handing a human a slightly noisy diff is a smaller failure than handing them nothing.
 *
 * Reporting the paths is MAPCO-11435's to add — the SDK's `tool_use` blocks carry them, they are
 * simply thrown away — and this whole branch disappears the day they arrive.
 */
const UNREPORTED_WRITES = 'unreported';

/**
 * The paths the agent wrote, or the fact that nothing knows them.
 *
 * Absolute or repo-relative: the model's file tools report the absolute path the Agent SDK
 * handed them, git prints repo-relative ones, and `toRepoRelative` reconciles the two so that a
 * correct caller cannot be wrong about which dialect this wants.
 */
type WriteList = readonly string[] | typeof UNREPORTED_WRITES;

/**
 * Why no pull request was opened, when nothing actually failed.
 *
 * `nothing-to-commit` is the working tree being clean: the verify slice ran and left no diff.
 * An empty pull request is not a smaller result than a full one, it is noise on a repo and a
 * reviewer's time spent finding out there is nothing there.
 *
 * `nothing-the-agent-wrote` is the tree being dirty with files the agent never touched, which
 * is the ordinary state of a checkout that has just had `npm ci` and a test suite run through
 * it: a repo that commits no lockfile gets a `package-lock.json` written into it, a test script
 * leaves coverage or build output behind. Opening a pull request on that would put a machine-
 * generated diff in front of a reviewer under a body claiming it was verified. The two
 * refusals are told apart because they mean different things to whoever reads the log line.
 */
type PublishRefusal = 'nothing-to-commit' | 'nothing-the-agent-wrote';

type PublishOutcome =
  | {
      readonly ok: true;
      readonly branch: string;
      readonly commit: string;
      readonly pullRequest: PullRequest;
      /** Whether the ticket got the comment. False means the pull request exists anyway. */
      readonly commented: boolean;
    }
  | { readonly ok: false; readonly reason: PublishRefusal };

interface PublishRequest {
  readonly ticket: JiraTicket;
  /** GitHub's canonical repo, which is where the default branch comes from. */
  readonly repo: Repo;
  /** What the verify slice ran. Goes into the body verbatim. */
  readonly checks: readonly VerifiedCheck[];
  /**
   * The paths the agent reported writing, or `UNREPORTED_WRITES` when nothing can report them.
   *
   * A list is an allow-list: the model has `Edit`, `Write` and `NotebookEdit` and no shell, so
   * it can create and modify files and cannot delete or rename one, which makes a write list a
   * complete description of what it did. A path that is listed but unchanged is dropped, a path
   * that changed but is not listed is left in the working tree uncommitted and named in a
   * warning, and a path that resolves outside the checkout is refused and named as well.
   *
   * Entries may be absolute or repo-relative; see `WriteList`. `UNREPORTED_WRITES` is the state
   * the pipeline is in until MAPCO-11435 forwards the paths — see the sentinel's own note.
   */
  readonly wrote: WriteList;
}

interface PublishDeps {
  readonly git: GitPort;
  readonly pullRequests: PullRequestPort;
  /** The Jira comment path only. Claim, release and transition are MAPCO-11431's. */
  readonly tickets: TicketCommentPort;
  readonly logger: Logger;
}

/** Which paths a commit will contain, and why the rest of the tree is not in it. */
interface Staging {
  readonly kind: StagingKind;
  /** Exactly what gets staged, in the working tree's own order so the argv is deterministic. */
  readonly staging: readonly string[];
  /** Changed paths nobody reported writing. Left in the tree, uncommitted, and logged. */
  readonly generated: readonly string[];
  /** Reported writes that do not resolve to a path inside the checkout. */
  readonly outside: readonly string[];
}

/**
 * Decide what goes in the commit.
 *
 * The intersection of "changed" and "written", with the two sides first brought into the same
 * dialect — git's repo-relative paths and the Agent SDK's absolute ones (`toRepoRelative`).
 * Both directions of the mismatch are reported by the caller: a path the agent claims it wrote
 * but that has no diff usually means it wrote the file back unchanged, and a changed path nobody
 * wrote is tool output. Either is something a human should be able to find in Loki afterwards.
 *
 * With no write list at all, every changed path is staged and the caller says so loudly in both
 * the log and the pull request body — see `UNREPORTED_WRITES` for why that is the better of the
 * two available failures.
 */
function selectStaging(changed: readonly string[], wrote: WriteList, root: string): Staging {
  if (wrote === UNREPORTED_WRITES) {
    return { kind: 'everything-changed', staging: changed, generated: [], outside: [] };
  }

  const reported = new Set<string>();
  const outside: string[] = [];

  for (const candidate of wrote) {
    const inside = toRepoRelative(candidate, root);

    if (inside === null) {
      outside.push(candidate);
    } else {
      reported.add(inside);
    }
  }

  return {
    kind: 'agent-reported',
    staging: changed.filter((path) => reported.has(path)),
    generated: changed.filter((path) => !reported.has(path)),
    outside,
  };
}

/**
 * Turn a verified working tree into a reviewable pull request.
 *
 * Every string that ends up on the repository — the branch, the commit subject, the pull
 * request title — is computed here from the Jira issue by `vcs/naming.ts`. None of it is asked
 * of the model, which has no git and no GitHub capability to act on an answer with anyway. That
 * is the whole point of MAPCO-11436: the naming rules and the "no master, no merge, no approve"
 * rules hold because the code is the only thing that can perform any of it.
 *
 * The order is commit, push, open, comment, and it is the order it reads. Unlike the release
 * path in `tickets/claim.ts`, none of these steps make the ticket available to another worker,
 * so there is no ordering trap here — the only rule is that the comment goes last, because it
 * links a pull request that has to exist first.
 *
 * A failure in git or in the GitHub API throws, on purpose. It is `handleTicket`'s per-ticket
 * try/catch that contains it (MAPCO-11431 owns that seam), and what it leaves behind is a
 * pushed `agent/` branch with no pull request — greppable by prefix, harmless, and a much
 * better state than a half-reported success.
 */
async function publishPullRequest(request: PublishRequest, deps: PublishDeps): Promise<PublishOutcome> {
  const { ticket, repo, checks, wrote } = request;
  const { git, pullRequests, tickets, logger } = deps;

  const changed = await git.changedFiles();

  if (changed.length === 0) {
    logger.warn({ msg: 'nothing to publish', key: ticket.key, repo: repo.fullName });

    return { ok: false, reason: 'nothing-to-commit' };
  }

  const selection = selectStaging(changed, wrote, git.root);

  if (selection.outside.length > 0) {
    // Not a refusal of the ticket: the agent may legitimately have read something outside the
    // clone, and the interesting case — a path that walks out of it — is worth seeing by name.
    logger.warn({ msg: 'ignoring reported writes outside the checkout', key: ticket.key, repo: repo.fullName, paths: selection.outside });
  }

  if (selection.generated.length > 0) {
    logger.warn({ msg: 'leaving changed paths out of the commit', key: ticket.key, repo: repo.fullName, paths: selection.generated });
  }

  if (selection.kind === 'everything-changed') {
    // The one line that says this pull request's diff was not filtered by anything. It is in the
    // body too, but a reviewer reads the body and an operator reads Loki.
    logger.warn({ msg: 'committing every changed path: no write list was reported', key: ticket.key, repo: repo.fullName, paths: selection.staging });
  }

  if (selection.staging.length === 0) {
    logger.warn({ msg: 'nothing the agent wrote is changed', key: ticket.key, repo: repo.fullName, changed, wrote });

    return { ok: false, reason: 'nothing-the-agent-wrote' };
  }

  const { staging } = selection;
  const branch = branchName(ticket);

  await git.createBranch(branch);
  const commit = await git.commit(commitMessage(ticket), staging);
  await git.push(branch);

  const pullRequest = await pullRequests.open(repo, {
    head: branch,
    // The default branch GitHub reported for this repo, never a hard-coded `master` — the org
    // has both, and a wrong base opens a pull request full of somebody else's commits.
    base: repo.defaultBranch,
    // The same string as the commit subject: a squash merge uses the pull request title as the
    // commit message on the default branch, so this is what release-please reads.
    title: commitTitle(ticket),
    body: buildPullRequestBody({ ticket, branch, checks, staging: selection.kind }),
  });

  logger.info({ msg: 'pull request opened', key: ticket.key, repo: repo.fullName, branch, commit, files: staging.length, url: pullRequest.url });

  return { ok: true, branch, commit, pullRequest, commented: await comment(ticket, branch, pullRequest, tickets, logger) };
}

/**
 * Put the pull request link on the ticket.
 *
 * Contained rather than thrown: the pull request already exists and is already reviewable, and
 * a Jira outage in the last half-second must not turn a published result into a failed one. The
 * comment is how a human finds the pull request, so losing it is worth a warning — and worth
 * reporting in the outcome — but it is not worth discarding the work.
 */
async function comment(ticket: JiraTicket, branch: string, pullRequest: PullRequest, tickets: TicketCommentPort, logger: Logger): Promise<boolean> {
  try {
    await tickets.addComment(ticket.key, buildTicketComment(ticket, branch, pullRequest));

    return true;
  } catch (err) {
    logger.warn({ msg: 'pull request opened but not linked on the ticket', key: ticket.key, url: pullRequest.url, err });

    return false;
  }
}

export { publishPullRequest, UNREPORTED_WRITES };
export type { PublishDeps, PublishOutcome, PublishRefusal, PublishRequest, WriteList };
