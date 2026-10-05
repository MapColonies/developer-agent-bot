import { execFile } from 'node:child_process';
import { devNull } from 'node:os';
import { promisify } from 'node:util';

/**
 * How the worker invokes git, and how the push credential reaches it.
 *
 * Extracted so the two places that run git — cloning a repository in (src/vcs/clone.ts) and
 * committing and pushing one out (src/vcs/cliGit.ts) — share one answer to the questions that
 * are easy to get subtly wrong: never prompt a human, never put a token in argv, never let the
 * target repository's own hooks decide whether the worker's git succeeds, and never echo a
 * credential into an error message. Two copies of that would eventually disagree, and the copy
 * that drifts is the one nobody is looking at.
 */

const run = promisify(execFile);

/**
 * Room for git's own output. The default 1 MiB is enough for a push, but `status --porcelain`
 * on a large generated diff is not worth failing with `ENOBUFS` over.
 */
const MAX_OUTPUT_BYTES = 10_485_760;
/** What a redacted secret reads as in an error message. */
const REDACTED = '***';

/**
 * Never ask a human anything.
 *
 * git's default is to prompt on a missing or rejected credential, and a prompt on a process
 * with no terminal is a process that waits until the timeout rather than failing with a usable
 * message. `GIT_TERMINAL_PROMPT=0` turns the prompt into an immediate error; the askpass
 * variables are emptied because a developer machine — where `npm run dry-run` runs — often has
 * a graphical credential helper configured that would otherwise pop a window nobody sees.
 */
/* eslint-disable @typescript-eslint/naming-convention -- environment variable names, not identifiers */
const NON_INTERACTIVE: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GCM_INTERACTIVE: 'never',
};
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * The environment variable the push credential is handed over in, and the helper that reads it.
 *
 * The token used to be interpolated into the push URL, which put it in git's argv — and argv is
 * world-readable through `/proc/<pid>/cmdline`, so any process on the host could read a live
 * installation token with org-wide write access straight out of the process table. It did not
 * even need to be a process the worker started: the model has `Write`, the verify slice runs
 * the clone's own `npm test`, and a rewritten test script therefore gets same-user execution in
 * the same container minutes before the push happens (containing that is MAPCO-11430's job, but
 * the token need not be reachable for it to matter).
 *
 * A credential helper is git's own answer to this. The helper is a shell snippet — git runs a
 * `!`-prefixed value through `sh -c` with the operation appended — and the snippet contains no
 * secret, only the *name* of a variable. The value travels in the child's environment, which
 * `/proc/<pid>/environ` exposes to the process owner alone rather than to everybody. The empty
 * `credential.helper=` in front of it resets the helper list, so a helper inherited from a
 * developer's global config cannot answer first with a stale credential of its own.
 *
 * `case` rather than `test "$1" = get &&`, so the snippet exits zero on the `store` and `erase`
 * operations git also calls it with instead of looking like a failing helper.
 */
const TOKEN_ENV = 'GIT_AGENT_PUSH_TOKEN';
/* Exported so that `tests/unit/vcs/scratchRepo.spec.ts` can hand the snippet to the real git and
 * watch it answer, rather than asserting that one string equals another string. A shell snippet
 * git runs through `sh -c` is not something a mock can tell you is correct. */
const CREDENTIAL_FROM_ENV = [
  '-c',
  'credential.helper=',
  '-c',
  `credential.helper=!f() { case "$1" in get) printf 'username=x-access-token\\npassword=%s\\n' "$${TOKEN_ENV}" ;; esac; }; f`,
];

/**
 * Every git invocation that could fire a hook carries this, and it is the reason the publish
 * path cannot be killed by the repository it is working on.
 *
 * The clone is an arbitrary repository whose hooks the verify slice has just installed for us:
 * `npm ci` runs `prepare`, which runs husky, which is how a `pre-commit` running `pretty-quick`
 * and a `commit-msg` running `commitlint` end up live in the checkout. Those hooks are a
 * contract between that repo and its humans; they are arbitrary code, and any one of them
 * exiting non-zero loses the whole result — no commit, no branch, no pull request, no comment on
 * the ticket. The repo's real gate on this change is the pull request's own CI plus a human
 * review, and both still run.
 *
 * `--no-verify` was the first attempt and is **not** enough: it bypasses `pre-commit` and
 * `commit-msg` only, so a `prepare-commit-msg` hook still runs — and still fails, and can also
 * rewrite the header this worker computed. Observed in the scratch repo in
 * `tests/unit/vcs/scratchRepo.spec.ts`, which is what a hooks-path of nothing fixes and
 * `--no-verify` did not. Pointing `core.hooksPath` at `/dev/null` means git looks for every hook
 * inside a path that is not a directory and finds none of them.
 *
 * None of this excuses writing a header the org's `commit-msg` hook would reject: `naming.ts`
 * emits one commitlint accepts, because a squash merge puts that string on the default branch
 * where the hook is not bypassed.
 */
const HOOKS_OFF = ['-c', `core.hooksPath=${devNull}`];

/**
 * Credentials that reached an error message anyway, in `https://user:secret@host` form.
 *
 * Belt and braces next to redacting the minted token by value. This worker never builds such a
 * URL any more — the credential goes to git through the environment — but git echoes back
 * whatever remote it was given, a clone URL from GitHub's API could carry credentials, and a
 * token in a log line outlives the token's own hour.
 */
const URL_CREDENTIALS = /\/\/[^@/\s]+@/gu;

/**
 * Runs git and resolves its stdout. Injected so the guards can be tested without a checkout.
 *
 * `env` is additions to the child's environment, not a replacement for it, and exists for one
 * reason: it is how the push credential reaches git without ever appearing in its argv.
 */
type RunGit = (args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<string>;

/**
 * A `RunGit` that kills any one invocation after `timeoutMs`.
 *
 * The bound is per caller because the two callers are not comparable: a commit is a local write
 * and a clone of a large repository is a network transfer. What they share is that neither may
 * hang forever — `publishPullRequest` is awaited by `handleTicket` which is awaited by
 * `runCycle`, so one stuck git invocation stops the scheduler from ever ticking again, and the
 * pod stays alive and healthy while the queue silently stops (it is outbound-only, so no probe
 * kills it — MAPCO-11430).
 */
function gitRunner(timeoutMs: number): RunGit {
  return async (args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<string> => {
    // `execFile`, never `exec`: arguments are passed as an array, so there is no shell to quote
    // for and a branch name or a commit message cannot become a second command.
    const { stdout } = await run('git', [...args], {
      cwd,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: timeoutMs,
      // A git that ignored the term signal would otherwise keep the promise pending past the
      // timeout, which is the whole failure the timeout exists to prevent.
      killSignal: 'SIGKILL',
      env: { ...process.env, ...NON_INTERACTIVE, ...env },
    });

    return stdout;
  };
}

/** Replace a token, and any credentials in a URL, wherever they appear in a message. */
function redact(message: string, token: string): string {
  const withoutToken = token === '' ? message : message.split(token).join(REDACTED);

  return withoutToken.replace(URL_CREDENTIALS, `//${REDACTED}@`);
}

export { CREDENTIAL_FROM_ENV, gitRunner, HOOKS_OFF, MAX_OUTPUT_BYTES, NON_INTERACTIVE, redact, REDACTED, TOKEN_ENV };
export type { RunGit };
