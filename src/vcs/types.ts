/**
 * The git surface the worker uses, and the credential it uses it with.
 *
 * Everything in here is **worker code**. The Agent SDK is given file and test tools only, so
 * the model has no way to run git, no way to reach a remote and no way to see a token — the
 * branch name, the commit and the push are computed and performed by this layer instead of
 * being asked for in a prompt. MAPCO-11436's whole point is that "never push to master" is a
 * property of code, not a sentence in an instruction file.
 */

import type { Repo } from '../github/types';

/** Who a commit is authored by. */
interface GitIdentity {
  /** Author and committer name. For the App this is `{app-slug}[bot]`. */
  readonly name: string;
  /** Author and committer email. For the App this is `{app-id}+{app-slug}[bot]@users.noreply.github.com`. */
  readonly email: string;
}

/**
 * Source of the credential used to push and to open a pull request.
 *
 * The contract is deliberately narrow and deliberately a *function*: every call mints a
 * fresh, short-lived token, so there is nowhere for a long-lived secret to be stored and
 * nothing to rotate. A GitHub App installation token lasts an hour; a run that outlives one
 * mints another rather than holding one open.
 *
 * The real implementation is the GitHub App itself, which is MAPCO-11428 and does not exist yet.
 * Nothing here signs an App JWT — this slice depends on the contract only, so that the
 * "never a static token" rule is expressed in the type rather than in a README paragraph.
 * The same credential is what clones the repository and opens the pull request, which is why the
 * port lives beside git rather than beside any one caller.
 *
 * What is bound to it today is `envTokenProvider` (src/vcs/envToken.ts), which reads one static
 * `GITHUB_TOKEN` and therefore honours the shape but not the promise. It exists to be deleted;
 * everything around it already treats the credential as short-lived.
 */
interface TokenProvider {
  mint: () => Promise<string>;
}

/**
 * What the worker does to a checkout that the verify slice has already left a diff in.
 *
 * Staging is not a separate step, but it is not "everything" either: `commit` takes the exact
 * paths it is to stage. A checkout that has just had `npm ci` and the repo's own test script run
 * through it is full of tool output, and only some repos gitignore all of it. There is no
 * `merge`, no `forcePush` and no `checkout` of an arbitrary ref, because a capability that does
 * not exist cannot be mis-used by a later slice.
 */
interface GitPort {
  /**
   * The checkout this port works in, absolute.
   *
   * Exposed because the publish path has to translate between two dialects of "a path in this
   * repository": git prints repo-relative paths, and the model's file tools report the absolute
   * ones the Agent SDK gave them. `vcs/paths.ts` does the translation and needs the root to do
   * it; making the caller carry the same directory a second time would be two sources of truth
   * for one fact, and the one that drifts is the one nothing notices.
   */
  readonly root: string;
  /**
   * Paths that differ from `HEAD`, staged or not. Empty means the verify slice produced no
   * diff, and an empty pull request is never worth opening.
   */
  changedFiles: () => Promise<readonly string[]>;
  /** Create and switch to a branch. Rejects anything outside `agent/`. */
  createBranch: (branch: string) => Promise<void>;
  /**
   * Stage exactly `paths` and commit them. Resolves to the new commit's sha.
   *
   * Rejects an empty list and any path that is not a literal path inside the checkout, so
   * "commit the whole working tree" is not a thing a caller can ask for by accident.
   */
  commit: (message: string, paths: readonly string[]) => Promise<string>;
  /** Push one branch to the remote. Rejects anything outside `agent/`, and never forces. */
  push: (branch: string) => Promise<void>;
}

/**
 * One ticket's clone, and the promise that it goes away again.
 *
 * `dispose` is separate from `create` rather than a scope-bounded callback because the two are
 * not symmetric in the caller: the clone is made once and then handed to three different steps
 * (the model, the test runner, the publish path), and a callback would have to wrap all of them
 * in one function whose signature grew with every slice. What the caller owes is a `finally`.
 */
interface Workspace {
  /** The clone, absolute. This is the `workdir` the model is confined to. */
  readonly dir: string;
  /**
   * Remove the workspace. Never rejects, and safe to call more than once.
   *
   * Both properties are there because the only correct place to call this is a `finally`, where
   * a rejection would replace the outcome the caller was about to report with a complaint about
   * a directory. A cleanup that failed is worth a log line and nothing more; MAPCO-11433's
   * "cleaned up on every path" is about the disk, not about the ticket.
   */
  dispose: () => Promise<void>;
}

/**
 * Where the worker gets a checkout to work in.
 *
 * Deliberately not a member of `GitPort`: that port is what the worker does to a checkout it
 * already has, and its whole argument is that a capability which does not exist cannot be
 * mis-used. Cloning is the act that *creates* the checkout, it happens before there is a
 * `GitPort` at all, and it is the one git operation the publish path has no business reaching.
 */
interface WorkspacePort {
  /** Clone `repo` at its default branch into a directory nothing else is using. */
  create: (repo: Repo) => Promise<Workspace>;
}

export type { GitIdentity, GitPort, TokenProvider, Workspace, WorkspacePort };
