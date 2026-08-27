import type { Repo } from '../github/types';

/**
 * One thing the verify slice ran in the checkout before any of this was allowed to happen.
 *
 * Declared here rather than imported because the verify slice (MAPCO-11434) does not exist
 * yet: this is the narrowest shape a pull-request body needs in order to say what was checked,
 * and it is the caller's job to fill it in honestly. `passed: false` is representable on
 * purpose — a body that can only describe success is a body that will eventually lie.
 */
interface VerifiedCheck {
  /** Exactly what was run, as a reviewer would run it themselves. */
  readonly command: string;
  readonly passed: boolean;
}

/**
 * How the commit's file list was chosen, which is something a reviewer has to be told.
 *
 * `agent-reported` is the intended shape: only the files the agent said it wrote. `everything-
 * changed` is what the worker does when nothing can tell it which files those were — see
 * `UNREPORTED_WRITES` in `publish.ts` — and it is a distinct value rather than a silent fallback
 * precisely so the pull request body can say which of the two produced its diff.
 */
type StagingKind = 'agent-reported' | 'everything-changed';

/** Everything GitHub needs to open the pull request, and nothing it does not. */
interface PullRequestDraft {
  /** The branch the work is on. */
  readonly head: string;
  /** The branch it is proposed into — the repo's real default branch, never a guess. */
  readonly base: string;
  /** Conventional-commit title, computed from the Jira issue in `vcs/naming.ts`. */
  readonly title: string;
  readonly body: string;
}

/** A pull request that exists. */
interface PullRequest {
  readonly number: number;
  /** The `html_url`, which is what goes on the ticket for a human to click. */
  readonly url: string;
}

/**
 * Opening a pull request, and nothing else.
 *
 * There is no `merge`, no `approve`, no `requestReviewers` and no `update`. Those are the acts
 * MAPCO-11436 says a machine must not perform, and the cheapest way to guarantee it is a port
 * that cannot express them — the App's own permissions are the second layer (MAPCO-11428), not
 * the only one. Reviewer routing is MAPCO-11378 and will need its own port when it lands.
 */
interface PullRequestPort {
  open: (repo: Repo, draft: PullRequestDraft) => Promise<PullRequest>;
}

/**
 * The one Jira write this slice needs: a comment saying where the pull request is.
 *
 * Deliberately a single-member port rather than a dependency on `JiraPort`. Claiming,
 * releasing, assigning and transitioning belong to MAPCO-11431 and are not implemented, or
 * even reachable, from here. The member is spelled `addComment` so that `JiraPort` already
 * satisfies this structurally — wiring it up is passing the same object, not writing an adapter.
 */
interface TicketCommentPort {
  addComment: (issueKey: string, body: string) => Promise<void>;
}

export type { PullRequest, PullRequestDraft, PullRequestPort, StagingKind, TicketCommentPort, VerifiedCheck };
