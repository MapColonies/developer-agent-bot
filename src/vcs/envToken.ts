/**
 * The interim `TokenProvider`, until the GitHub App exists (MAPCO-11428).
 *
 * `TokenProvider` is deliberately a *function* so that every call mints a fresh, short-lived
 * installation token and there is nowhere for a long-lived secret to live. This implementation
 * does not honour that — it reads one static token out of the environment — and it exists
 * because the alternative is worse in a way that is easy to miss: without any implementation the
 * clone, the push and the pull request cannot be constructed at all, so the whole pipeline is
 * unreachable and the wiring cannot be shown to work end to end.
 *
 * So it is here, named for what it is, in a file whose only job is to be deleted. What it does
 * buy is that the *shape* is already right everywhere else: the token is minted per call and
 * never held, it reaches git through the environment rather than argv, and it is redacted out of
 * error messages. Swapping this for the App is one line in `src/worker.ts`.
 *
 * `GITHUB_TOKEN` is the same variable `RestGitHub` already uses for repo lookups and the same
 * one `SECRET_ENV_NAMES` (src/workspace/subprocess.ts) strips out of both the model's process
 * and the clone's test run — so a PAT here is not reachable by the code the worker runs on a
 * ticket's behalf.
 */

/** The variable the interim credential is read from. A PAT locally, a token in the cluster. */
const GITHUB_TOKEN_ENV = 'GITHUB_TOKEN';

/**
 * A missing GitHub credential.
 *
 * Its own class for the same reason as `AgentConfigError` and `ConfigError`: it is a deployment
 * fault and it must not read as a ticket that failed.
 */
class TokenError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

/**
 * The GitHub credential, or a thrown `TokenError`.
 *
 * Called at boot by `createWorker` — where the value is discarded — and again on every mint. The
 * boot call is the important one and it is there for the same reason `readModelCredential` is: without a
 * credential the worker cannot finish a single ticket, and the failure would otherwise land
 * *per ticket*, as a claim, a clone that refuses, a comment naming an environment variable, and
 * an attempt counted against somebody's ticket. Two of those retire it from the queue. A pod
 * that will not come up is a much cheaper way to learn the Secret did not arrive.
 *
 * Note that this makes the credential effectively required even for a public repository. That is
 * the right trade: a clone can manage without one, but the push cannot, so a tokenless worker
 * would fail *after* paying for the model rather than before.
 */
function readGitHubToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env[GITHUB_TOKEN_ENV]?.trim() ?? '';

  if (token === '') {
    throw new TokenError(
      `${GITHUB_TOKEN_ENV} must be set — the worker has no other way to clone a repository, push a branch or open a pull request until the GitHub App lands (MAPCO-11428).`
    );
  }

  return token;
}

/**
 * Reads the environment on every call, rather than once at construction.
 *
 * Not laziness: it is the behaviour the App will have, so nothing downstream gets built around a
 * credential that is fetched once and cached. The real provider hands out a token that expires
 * in an hour, and a run that outlives one mints another.
 */
function envTokenProvider(env: NodeJS.ProcessEnv = process.env): { mint: () => Promise<string> } {
  return { mint: async (): Promise<string> => Promise.resolve(readGitHubToken(env)) };
}

export { envTokenProvider, GITHUB_TOKEN_ENV, readGitHubToken, TokenError };
