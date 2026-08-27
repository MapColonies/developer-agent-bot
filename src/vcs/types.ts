/**
 * The git surface the worker uses, and the credential it uses it with.
 *
 * Everything in here is **worker code**. The Agent SDK is given file and test tools only, so
 * the model has no way to run git, no way to reach a remote and no way to see a token — the
 * branch name, the commit and the push are computed and performed by this layer instead of
 * being asked for in a prompt. MAPCO-11436's whole point is that "never push to master" is a
 * property of code, not a sentence in an instruction file.
 */

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
 * The implementation is the GitHub App itself, which is MAPCO-11428 and does not exist yet.
 * Nothing here signs an App JWT — this slice depends on the contract only, so that the
 * "never a static token" rule is expressed in the type rather than in a README paragraph.
 * The same credential is what opens the pull request, which is why the port lives beside git
 * rather than beside either caller.
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

export type { GitIdentity, GitPort, TokenProvider };
