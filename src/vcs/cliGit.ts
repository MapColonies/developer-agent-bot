import { execFile } from 'node:child_process';
import { devNull } from 'node:os';
import { promisify } from 'node:util';
import type { Repo } from '../github/types';
import { AGENT_PREFIX } from './naming';
import type { GitIdentity, GitPort, TokenProvider } from './types';

const run = promisify(execFile);

/** `git status --porcelain` prefixes every path with two status letters and a space. */
const STATUS_PREFIX_LENGTH = 3;
/** Porcelain writes a rename as `old -> new`; the new path is the one that exists. */
const RENAME_ARROW = ' -> ';
/**
 * Room for git's own output. The default 1 MiB is enough for a push, but `status --porcelain`
 * on a large generated diff is not worth failing with `ENOBUFS` over.
 */
const MAX_OUTPUT_BYTES = 10_485_760;
/** What a redacted secret reads as in an error message. */
const REDACTED = '***';

/**
 * How long any one git invocation may take before it is killed.
 *
 * Every other subprocess boundary in the worker is bounded — the verify slice's runner gives a
 * clone's own suite fifteen minutes (`src/workspace/subprocess.ts`) — and this one used to be
 * the exception. The failure it prevents is specific: a push to a remote behind a proxy that
 * completes the handshake and then answers nothing hangs `execFile` forever, and because
 * `publishPullRequest` is awaited by `handleTicket` which is awaited by `runCycle`, one hung
 * push stops the scheduler from ever ticking again. The pod stays alive and healthy — it is
 * outbound-only, so no probe kills it (MAPCO-11430) — and the queue simply stops.
 *
 * Five minutes rather than fifteen: nothing here installs anything or runs a test suite. It is
 * a status, a checkout, a commit and a push, and a push that has not finished in five minutes
 * is not going to.
 */
const GIT_TIMEOUT_MS = 300_000;

/**
 * Never ask a human anything.
 *
 * git's default is to prompt on a missing or rejected credential, and a prompt on a process
 * with no terminal is a process that waits until the timeout above rather than failing with a
 * usable message. `GIT_TERMINAL_PROMPT=0` turns the prompt into an immediate error; the askpass
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
 * Refs the worker is allowed to write, matched in full.
 *
 * Anchored on `agent/` so the segment cannot be pushed rightwards, and allow-listing the rest
 * of the characters so a ref can never arrive with a leading `-` and be read by git as a flag.
 * `..` is excluded separately because a dot on its own is legal in a ref and a pair is not.
 */
const WRITABLE_REF = /^agent\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const REF_TRAVERSAL = '..';
const REF_LOCK_SUFFIX = '.lock';

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
 * Ask git to read every pathspec as one literal path.
 *
 * `git add -- <path>` still glob-matches its pathspecs and still honours a `:(glob)` magic
 * prefix, so a path arriving from the agent slice is not inert just because `execFile` gave it
 * no shell to escape into. This slice's first answer was an allow-list that refused any path
 * containing `*`, `?`, `[`, `]` or a backslash — which also refuses `app/[id]/page.tsx`, a
 * filename every Next.js repository in the org has and git stages without complaint (verified:
 * `git add -- 'app/[id]/page.tsx'` exits 0 and stages exactly that file). `--literal-pathspecs`
 * is git's own switch for the same problem — it disables wildmatch and magic prefixes for the
 * whole invocation — so the allow-list is redundant and the legitimate filename goes through.
 */
const LITERAL_PATHSPECS = '--literal-pathspecs';

/**
 * A control character in a path.
 *
 * The one shape still refused outright, and not for git's sake — git handles it. It is refused
 * because `status --porcelain` quotes a path containing a newline or a tab whatever
 * `core.quotePath` is set to, so the string this module printed and the string it is handed back
 * could never be the same one: the path would be reported as changed under one spelling, staged
 * under another, and quietly not be in the commit.
 */
/* eslint-disable-next-line no-control-regex -- a control character in a path is exactly what this matches */
const UNSAFE_PATH = /[\u0000-\u001F]/u;
const PARENT_SEGMENT = '..';
const GIT_DIR = '.git';

/**
 * Something the worker refuses to do to a repository, rather than something that went wrong.
 *
 * A throw and not a refusal value, unlike the Jira refusals: a caller asking to push `master`
 * is a bug in the caller, not a state the pipeline is expected to reach and report on.
 */
class GitGuardError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GitGuardError';
  }
}

/**
 * Runs git and resolves its stdout. Injected so the guards can be tested without a checkout.
 *
 * `env` is additions to the child's environment, not a replacement for it, and exists for one
 * reason: it is how the push credential reaches git without ever appearing in its argv.
 */
type RunGit = (args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<string>;

interface CliGitOptions {
  /** The checkout the verify slice left its diff in. */
  readonly cwd: string;
  /** The repo being worked, with GitHub's canonical name and its real default branch. */
  readonly repo: Repo;
  /** Author and committer of the commit. */
  readonly identity: GitIdentity;
  /** Mints the push credential. Called once per push, never held. */
  readonly tokens: TokenProvider;
  /** Overridden in tests. */
  readonly run?: RunGit;
}

async function execGit(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  // `execFile`, never `exec`: arguments are passed as an array, so there is no shell to quote
  // for and a branch name or a commit message cannot become a second command.
  const { stdout } = await run('git', [...args], {
    cwd,
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: GIT_TIMEOUT_MS,
    // A git that ignored the term signal would otherwise keep the promise pending past the
    // timeout, which is the whole failure the timeout exists to prevent.
    killSignal: 'SIGKILL',
    env: { ...process.env, ...NON_INTERACTIVE, ...env },
  });

  return stdout;
}

/** Replace a token, and any credentials in a URL, wherever they appear in a message. */
function redact(message: string, token: string): string {
  const withoutToken = token === '' ? message : message.split(token).join(REDACTED);

  return withoutToken.replace(URL_CREDENTIALS, `//${REDACTED}@`);
}

/**
 * Refuse any ref outside `agent/`.
 *
 * This is the acceptance criterion "pushing to master is observed to fail" expressed as code.
 * A prompt telling a model not to push to master enforces nothing; a push path that has no way
 * to name `master` cannot be talked into it, and the worker's own branch names are computed in
 * `naming.ts` rather than supplied by the model in the first place. The default branch is
 * rejected by name as well, in case a repo's default branch is itself under `agent/`.
 */
function assertWritable(branch: string, defaultBranch: string): void {
  if (!WRITABLE_REF.test(branch) || branch.includes(REF_TRAVERSAL) || branch.endsWith(REF_LOCK_SUFFIX)) {
    throw new GitGuardError(`refusing to write \`${branch}\`: the worker may only create and push refs under \`${AGENT_PREFIX}/\``);
  }

  if (branch === defaultBranch) {
    throw new GitGuardError(`refusing to write \`${branch}\`: it is the repository's default branch`);
  }
}

/**
 * Refuse to stage anything but a literal path inside the checkout.
 *
 * The paths come from the agent slice — the files the model reported writing — and the model is
 * the one input to this pipeline nobody controls. An empty list is refused rather than widened
 * to the whole tree: `git add --all` in a checkout that has just had `npm ci` and the repo's own
 * test script run through it commits whatever tool output the repo does not happen to gitignore,
 * and a pull request whose entire diff is a generated `package-lock.json` is worse than no pull
 * request at all.
 */
function assertCommittable(paths: readonly string[]): void {
  if (paths.length === 0) {
    throw new GitGuardError('refusing to commit: no paths were given, and the worker never stages a whole working tree');
  }

  for (const candidate of paths) {
    const segments = candidate.split('/');

    // An empty segment covers an absolute path, a trailing slash and a doubled slash at once.
    if (UNSAFE_PATH.test(candidate) || segments.some((segment) => segment === '' || segment === PARENT_SEGMENT || segment === GIT_DIR)) {
      throw new GitGuardError(`refusing to commit \`${candidate}\`: only literal paths inside the checkout may be staged`);
    }
  }
}

/**
 * git through its command line, with the worker's rules built in.
 *
 * The model never reaches this class: the Agent SDK gets file and test tools only, so a commit
 * happens because the worker decided to make one. There is no method here that merges, forces,
 * approves or deletes anything, so no later slice can reach for one by accident.
 */
class CliGit implements GitPort {
  /** The checkout, so a caller can turn an absolute path into the one git prints. */
  public readonly root: string;

  private readonly git: RunGit;

  public constructor(private readonly options: CliGitOptions) {
    this.root = options.cwd;
    this.git = options.run ?? execGit;
  }

  public async changedFiles(): Promise<readonly string[]> {
    // `--untracked-files=all` because the default collapses a whole new directory to `src/`,
    // and the caller matches these paths against the files the agent reported writing — a new
    // file in a new directory would never match `src/` and would silently not be committed.
    // `core.quotePath=false` because porcelain otherwise escapes a non-ASCII path as
    // `"src/caf\303\251.ts"`, which matches nothing either.
    const stdout = await this.git(['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all'], this.options.cwd);

    return stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const path = line.slice(STATUS_PREFIX_LENGTH);
        const arrow = path.indexOf(RENAME_ARROW);

        return arrow > 0 ? path.slice(arrow + RENAME_ARROW.length) : path;
      });
  }

  public async createBranch(branch: string): Promise<void> {
    assertWritable(branch, this.options.repo.defaultBranch);

    // `-b`, so an existing branch is an error rather than a silent switch onto somebody else's
    // work. A second attempt on the same ticket gets a fresh checkout, not a reused branch.
    // A `post-checkout` hook's exit status is `git checkout`'s exit status, hence `HOOKS_OFF`.
    await this.git([...HOOKS_OFF, 'checkout', '-b', branch], this.options.cwd);
  }

  public async commit(message: string, paths: readonly string[]): Promise<string> {
    assertCommittable(paths);

    // Exactly the paths the agent wrote, never `--all`. `--` ends the option list, so a path is
    // a path even if it starts with a dash, and `--literal-pathspecs` means the ones that look
    // like globs are the filenames they are rather than patterns.
    await this.git([LITERAL_PATHSPECS, 'add', '--', ...paths], this.options.cwd);

    // Configured with `-c` per invocation rather than written with `git config`: nothing the
    // worker does outlives the run, and a container's git config is shared by every ticket that
    // container ever handles.
    const config = [
      ...HOOKS_OFF,
      '-c',
      `user.name=${this.options.identity.name}`,
      '-c',
      `user.email=${this.options.identity.email}`,
      '-c',
      'commit.gpgsign=false',
    ];

    await this.git([...config, 'commit', '--message', message], this.options.cwd);

    return (await this.git(['rev-parse', 'HEAD'], this.options.cwd)).trim();
  }

  public async push(branch: string): Promise<void> {
    assertWritable(branch, this.options.repo.defaultBranch);

    // Minted here, one push at a time. Nothing stores it: it is not written to the remote's
    // config, not kept on the instance, and not in the argv — it reaches git through the child's
    // environment and the credential helper above, so it is not in the process table either.
    // What is left that could leak it is an error message, which is what `redact` is for.
    const token = await this.options.tokens.mint();

    try {
      // An explicit refspec and an explicit URL, and the URL is the plain clone URL with no
      // credentials in it. No `--force`, no `--set-upstream`, no named remote: whatever
      // `push.default` or `origin` happen to be in this checkout, this pushes exactly one branch
      // to exactly one ref and can create nothing else.
      // `HOOKS_OFF` here too: a `pre-push` hook is the target repo's own arbitrary code, and a
      // repo that runs its test suite on push must not be able to swallow a pushed branch.
      await this.git(
        [...HOOKS_OFF, ...CREDENTIAL_FROM_ENV, 'push', this.options.repo.cloneUrl, `refs/heads/${branch}:refs/heads/${branch}`],
        this.options.cwd,
        { [TOKEN_ENV]: token }
      );
    } catch (err) {
      // git echoes the remote URL back on failure, credentials included.
      throw new Error(redact(err instanceof Error ? err.message : String(err), token));
    }
  }
}

export { CliGit, CREDENTIAL_FROM_ENV, GitGuardError, TOKEN_ENV };
export type { CliGitOptions, RunGit };
