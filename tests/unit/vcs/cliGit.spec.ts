import { devNull } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { Repo } from '@src/github/types';
import { CliGit, GitGuardError, type RunGit } from '@src/vcs/cliGit';
import type { TokenProvider } from '@src/vcs/types';

const repo: Repo = {
  name: 'raster-shared',
  fullName: 'MapColonies/raster-shared',
  defaultBranch: 'master',
  cloneUrl: 'https://github.com/MapColonies/raster-shared.git',
};

/** What every hook-firing invocation has to carry. Spelled out once so each assertion reads. */
const HOOKS_OFF = ['-c', `core.hooksPath=${devNull}`];

/**
 * How the push credential reaches git: a helper that reads a variable, not a token in the argv.
 *
 * Written out in full rather than imported, so that a change to the snippet has to be made in
 * two places and read once — this is the string that decides whether a live installation token
 * ends up in the process table.
 */
const CREDENTIAL_FROM_ENV = [
  '-c',
  'credential.helper=',
  '-c',
  `credential.helper=!f() { case "$1" in get) printf 'username=x-access-token\\npassword=%s\\n' "$GIT_AGENT_PUSH_TOKEN" ;; esac; }; f`,
];

const identity = { name: 'mapcolonies-developer-agent[bot]', email: '1234+mapcolonies-developer-agent[bot]@users.noreply.github.com' };

interface FakeGit {
  readonly run: RunGit;
  /** Every git invocation, in order, as the argv it would really have been given. */
  readonly calls: string[][];
  /** The environment additions each invocation was given, in the same order as `calls`. */
  readonly envs: NodeJS.ProcessEnv[];
}

/**
 * A git that records its argv instead of running.
 *
 * The interesting assertions are all about what was *not* asked for — no `--force`, no
 * `master`, no `merge` — and those only exist if the argv is visible.
 */
function fakeGit(options: { readonly status?: string; readonly failOn?: string; readonly sha?: string } = {}): FakeGit {
  const calls: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];

  return {
    calls,
    envs,
    run: async (args: readonly string[], _cwd: string, env: NodeJS.ProcessEnv = {}): Promise<string> => {
      calls.push([...args]);
      envs.push({ ...env });

      if (options.failOn !== undefined && args.includes(options.failOn)) {
        // Shaped like a real git failure: the remote URL is echoed back, credentials included.
        throw new Error(`Command failed: git ${args.join(' ')}\nremote: Permission to MapColonies/raster-shared.git denied.`);
      }

      if (args.includes('status')) {
        return Promise.resolve(options.status ?? '');
      }

      if (args[0] === 'rev-parse') {
        return Promise.resolve(`${options.sha ?? 'deadbeef'}\n`);
      }

      return Promise.resolve('');
    },
  };
}

/** Mints a different token every time, which is how "minted per call" is observable at all. */
function fakeTokens(): TokenProvider & { readonly minted: string[] } {
  const minted: string[] = [];

  return {
    minted,
    mint: async (): Promise<string> => {
      const token = `ghs-token-${minted.length + 1}`;
      minted.push(token);

      return Promise.resolve(token);
    },
  };
}

function cliGit(git: FakeGit, tokens: TokenProvider = fakeTokens()): CliGit {
  return new CliGit({ cwd: '/tmp/checkout', repo, identity, tokens, run: git.run });
}

describe('CliGit.changedFiles', () => {
  it('should report the paths the verify slice touched.', async () => {
    const git = fakeGit({ status: ' M src/tiles.ts\n?? src/new.ts\n' });

    await expect(cliGit(git).changedFiles()).resolves.toStrictEqual(['src/tiles.ts', 'src/new.ts']);
    expect(git.calls).toStrictEqual([['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all']]);
  });

  it('should report the new path of a rename, which is the one that exists.', async () => {
    const git = fakeGit({ status: 'R  src/old.ts -> src/new.ts\n' });

    await expect(cliGit(git).changedFiles()).resolves.toStrictEqual(['src/new.ts']);
  });

  it('should list every untracked file rather than a collapsed directory.', async () => {
    // The default porcelain output is `?? src/`, and the caller matches these paths against the
    // files the agent said it wrote — a new file in a new directory would match nothing and
    // would quietly not be committed.
    const git = fakeGit();

    await cliGit(git).changedFiles();

    expect(git.calls[0]).toContain('--untracked-files=all');
    expect(git.calls[0]).toContain('core.quotePath=false');
  });

  it('should report a clean tree as nothing at all.', async () => {
    const git = fakeGit({ status: '\n' });

    await expect(cliGit(git).changedFiles()).resolves.toStrictEqual([]);
  });
});

describe('CliGit.createBranch', () => {
  it('should create the branch and switch onto it.', async () => {
    const git = fakeGit();

    await cliGit(git).createBranch('agent/feat/MAPCO-1-do-the-thing');

    expect(git.calls).toStrictEqual([[...HOOKS_OFF, 'checkout', '-b', 'agent/feat/MAPCO-1-do-the-thing']]);
  });

  it('should refuse to create a branch outside agent/, so the prefix cannot be lost by accident.', async () => {
    const git = fakeGit();

    await expect(cliGit(git).createBranch('feat/MAPCO-1-do-the-thing')).rejects.toThrow(GitGuardError);
    expect(git.calls).toStrictEqual([]);
  });
});

describe('CliGit.commit', () => {
  it('should stage exactly the paths it was given, commit them and report the new sha.', async () => {
    const git = fakeGit({ sha: 'a1b2c3d' });

    await expect(cliGit(git).commit('feat: do the thing (MAPCO-1)', ['src/tiles.ts', 'src/new.ts'])).resolves.toBe('a1b2c3d');

    expect(git.calls[0]).toStrictEqual(['--literal-pathspecs', 'add', '--', 'src/tiles.ts', 'src/new.ts']);
    expect(git.calls[1]).toStrictEqual([
      ...HOOKS_OFF,
      '-c',
      'user.name=mapcolonies-developer-agent[bot]',
      '-c',
      'user.email=1234+mapcolonies-developer-agent[bot]@users.noreply.github.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--message',
      'feat: do the thing (MAPCO-1)',
    ]);
    expect(git.calls[2]).toStrictEqual(['rev-parse', 'HEAD']);
  });

  it('should never stage the whole working tree.', async () => {
    // `git add --all` in a clone that has just had `npm ci` and the repo's test script run
    // through it commits whatever tool output the repo does not gitignore — a pull request whose
    // entire diff is a generated `package-lock.json`.
    const git = fakeGit();

    await cliGit(git).commit('chore: do the thing (MAPCO-1)', ['src/tiles.ts']);

    expect(git.calls.some((args) => args.includes('--all'))).toBe(false);
    expect(git.calls.some((args) => args.includes('-A'))).toBe(false);
  });

  it('should refuse to commit with no paths at all rather than widening to everything.', async () => {
    const git = fakeGit();

    await expect(cliGit(git).commit('chore: do the thing (MAPCO-1)', [])).rejects.toThrow(GitGuardError);
    expect(git.calls).toStrictEqual([]);
  });

  it('should refuse a path that is not inside the checkout.', async () => {
    // The paths come from the agent slice, which is the one input to this pipeline nobody
    // controls. What is refused is a path that leaves the checkout or reaches into `.git` —
    // not a path that merely looks like a pattern; see the next test.
    const git = fakeGit();
    const subject = cliGit(git);

    await expect(subject.commit('chore: x (MAPCO-1)', ['/etc/passwd'])).rejects.toThrow(GitGuardError);
    await expect(subject.commit('chore: x (MAPCO-1)', ['../outside/thing.ts'])).rejects.toThrow(GitGuardError);
    await expect(subject.commit('chore: x (MAPCO-1)', ['src/../../outside.ts'])).rejects.toThrow(GitGuardError);
    await expect(subject.commit('chore: x (MAPCO-1)', ['.git/config'])).rejects.toThrow(GitGuardError);
    await expect(subject.commit('chore: x (MAPCO-1)', ['src/\u0000hidden.ts'])).rejects.toThrow(GitGuardError);
    await expect(subject.commit('chore: x (MAPCO-1)', [''])).rejects.toThrow(GitGuardError);
    expect(git.calls).toStrictEqual([]);
  });

  it('should stage a filename that looks like a glob rather than refusing it.', async () => {
    // `app/[id]/page.tsx` is a real file in every Next.js repository in the org, and `git add`
    // stages it without complaint. The first version of this slice refused every path containing
    // `*`, `?`, `[`, `]` or a backslash, which turned a file git handles into a ticket that could
    // never be published. `--literal-pathspecs` is git's own answer: no wildmatch, no `:(glob)`
    // magic, every argument one literal path.
    const git = fakeGit();

    await cliGit(git).commit('chore: x (MAPCO-1)', ['app/[id]/page.tsx', 'src/what?.ts', 'src/a*b.ts']);

    expect(git.calls[0]).toStrictEqual(['--literal-pathspecs', 'add', '--', 'app/[id]/page.tsx', 'src/what?.ts', 'src/a*b.ts']);
  });

  it('should refuse the whole commit when one path in the list is bad.', async () => {
    // Partially staging a set and committing the rest is a worse outcome than refusing: the
    // pull request would look complete and be missing a file.
    const git = fakeGit();

    await expect(cliGit(git).commit('chore: x (MAPCO-1)', ['src/tiles.ts', '../escape.ts'])).rejects.toThrow(GitGuardError);
    expect(git.calls).toStrictEqual([]);
  });

  it("should not let the clone's own hooks swallow the result.", async () => {
    // The verify slice runs `npm ci` in the clone, whose `prepare` installs husky — so the
    // target repo's `pre-commit` and `commit-msg` are live by the time this runs. They are
    // arbitrary code belonging to that repo, and any one of them failing loses the commit, the
    // branch, the pull request and the ticket comment. The pull request's own CI still runs.
    //
    // `--no-verify` is deliberately not what does this: it leaves `prepare-commit-msg` running,
    // which fails just as fatally and can rewrite the header. Observed in scratchRepo.spec.ts.
    const git = fakeGit();

    await cliGit(git).commit('chore: do the thing (MAPCO-1)', ['src/tiles.ts']);

    expect(git.calls[1]?.slice(0, 2)).toStrictEqual(HOOKS_OFF);
    expect(git.calls[1]).not.toContain('--no-verify');
  });

  it('should not write the identity into the checkout, only onto the invocation.', async () => {
    // `git config user.name` would outlive the ticket and be inherited by the next one.
    const git = fakeGit();

    await cliGit(git).commit('chore: do the thing (MAPCO-1)', ['src/tiles.ts']);

    expect(git.calls.some((args) => args[0] === 'config')).toBe(false);
  });
});

describe('CliGit.push', () => {
  it('should push exactly one branch to exactly one ref, with no force and no named remote.', async () => {
    const git = fakeGit();
    const tokens = fakeTokens();

    await cliGit(git, tokens).push('agent/feat/MAPCO-1-do-the-thing');

    const [args] = git.calls;

    expect(args).toStrictEqual([
      ...HOOKS_OFF,
      ...CREDENTIAL_FROM_ENV,
      'push',
      'https://github.com/MapColonies/raster-shared.git',
      'refs/heads/agent/feat/MAPCO-1-do-the-thing:refs/heads/agent/feat/MAPCO-1-do-the-thing',
    ]);
    expect(args?.some((arg) => arg.includes('force'))).toBe(false);
  });

  it('should keep the token out of the argv and hand it over in the environment.', async () => {
    // argv is world-readable through `/proc/<pid>/cmdline`, so a token in the push URL is a live
    // installation credential any process on the host can read out of the process table — and
    // the model can arrange for a same-user process, because the verify slice runs the clone's
    // own test script. The environment is readable by the process owner only, and the helper in
    // the argv names the variable rather than carrying its value.
    const git = fakeGit();
    const tokens = fakeTokens();

    await cliGit(git, tokens).push('agent/feat/MAPCO-1-do-the-thing');

    expect(git.calls[0]?.some((arg) => arg.includes('ghs-token-1'))).toBe(false);
    /* eslint-disable-next-line @typescript-eslint/naming-convention -- the environment variable's real name is the assertion */
    expect(git.envs[0]).toStrictEqual({ GIT_AGENT_PUSH_TOKEN: 'ghs-token-1' });
    // The URL that reaches git carries no credentials at all, so there is nothing for git to
    // echo back into a log line either.
    expect(git.calls[0]).toContain('https://github.com/MapColonies/raster-shared.git');
  });

  it('should reset any credential helper the machine already has before adding its own.', async () => {
    // A developer's global config can name a helper that answers first with a stale credential
    // of its own, and `npm run dry-run` runs on exactly such a machine. An empty value resets
    // git's helper list, so the only helper left is the one that reads the minted token.
    const git = fakeGit();

    await cliGit(git).push('agent/feat/MAPCO-1-do-the-thing');

    expect(git.calls[0]?.indexOf('credential.helper=')).toBeGreaterThan(-1);
    expect(git.calls[0]?.findIndex((arg) => arg.startsWith('credential.helper=!'))).toBeGreaterThan(git.calls[0]?.indexOf('credential.helper=') ?? 0);
  });

  it('should mint a token for every push rather than reusing one.', async () => {
    // The credential is a GitHub App installation token, which expires in an hour. Reusing one
    // across a long-lived process is how a worker starts failing pushes at the 61st minute.
    const git = fakeGit();
    const tokens = fakeTokens();
    const subject = cliGit(git, tokens);

    await subject.push('agent/feat/MAPCO-1-one');
    await subject.push('agent/feat/MAPCO-2-two');

    expect(tokens.minted).toStrictEqual(['ghs-token-1', 'ghs-token-2']);
    /* eslint-disable-next-line @typescript-eslint/naming-convention -- the environment variable's real name is the assertion */
    expect(git.envs[1]).toStrictEqual({ GIT_AGENT_PUSH_TOKEN: 'ghs-token-2' });
  });

  it('should refuse to push the default branch.', async () => {
    // The criterion is that pushing to master fails. It fails here, before a token exists and
    // before git is invoked at all — a prompt saying "never push to master" enforces nothing.
    const git = fakeGit();
    const tokens = fakeTokens();

    await expect(cliGit(git, tokens).push('master')).rejects.toThrow(GitGuardError);
    expect(git.calls).toStrictEqual([]);
    expect(tokens.minted).toStrictEqual([]);
  });

  it('should refuse to push any branch that is not under agent/.', async () => {
    const git = fakeGit();

    await expect(cliGit(git).push('main')).rejects.toThrow(GitGuardError);
    await expect(cliGit(git).push('refs/heads/master')).rejects.toThrow(GitGuardError);
    await expect(cliGit(git).push('release/1.2.0')).rejects.toThrow(GitGuardError);
    await expect(cliGit(git).push('')).rejects.toThrow(GitGuardError);
    expect(git.calls).toStrictEqual([]);
  });

  it('should refuse a ref that tries to climb out of the agent prefix.', async () => {
    const git = fakeGit();

    await expect(cliGit(git).push('agent/../master')).rejects.toThrow(GitGuardError);
    await expect(cliGit(git).push('agent/feat/MAPCO-1.lock')).rejects.toThrow(GitGuardError);
    expect(git.calls).toStrictEqual([]);
  });

  it('should refuse a branch that would arrive at git as a flag.', async () => {
    const git = fakeGit();

    await expect(cliGit(git).push('--mirror')).rejects.toThrow(GitGuardError);
    expect(git.calls).toStrictEqual([]);
  });

  it("should refuse the default branch even when the repo's default branch is itself under agent/.", async () => {
    const git = fakeGit();
    const odd: Repo = { ...repo, defaultBranch: 'agent/main' };
    const subject = new CliGit({ cwd: '/tmp/checkout', repo: odd, identity, tokens: fakeTokens(), run: git.run });

    await expect(subject.push('agent/main')).rejects.toThrow(GitGuardError);
    expect(git.calls).toStrictEqual([]);
  });

  it('should keep the failure readable and the credentials out of it when a push fails.', async () => {
    // git echoes back the remote it was given, and a token in a log line outlives the token
    // itself. The failure still has to say what went wrong, so only the credentials go.
    const git = fakeGit({ failOn: 'push' });
    const tokens = fakeTokens();

    const failure = await cliGit(git, tokens)
      .push('agent/feat/MAPCO-1-do-the-thing')
      .catch((err: unknown) => String(err));

    expect(failure).toContain('Permission to MapColonies/raster-shared.git denied');
    expect(failure).not.toContain('ghs-token-1');
  });

  it('should redact credentials that a remote arrived with, not only the one it minted.', async () => {
    // This worker no longer builds an authenticated URL — the credential goes to git through the
    // environment — but a clone URL from GitHub's API, or a rewrite in somebody's git config, can
    // still put one in front of git, and git will quote it back.
    const tokens = fakeTokens();
    const run: RunGit = async (): Promise<string> =>
      Promise.reject(new Error('fatal: could not read from https://x-access-token:some-other-secret@github.com/MapColonies/raster-shared.git'));

    const failure = await new CliGit({ cwd: '/tmp/checkout', repo, identity, tokens, run })
      .push('agent/feat/MAPCO-1-do-the-thing')
      .catch((err: unknown) => String(err));

    expect(failure).not.toContain('some-other-secret');
    expect(failure).toBe('Error: fatal: could not read from https://***@github.com/MapColonies/raster-shared.git');
  });

  it('should redact the token by value, not only where it looks like a URL.', async () => {
    const tokens = fakeTokens();
    // A failure that mentions the token on its own, with no URL around it to match on.
    const run: RunGit = async (): Promise<string> => Promise.reject(new Error('fatal: authentication failed using ghs-token-1'));

    const failure = await new CliGit({ cwd: '/tmp/checkout', repo, identity, tokens, run })
      .push('agent/feat/MAPCO-1-do-the-thing')
      .catch((err: unknown) => String(err));

    expect(failure).not.toContain('ghs-token-1');
    expect(failure).toBe('Error: fatal: authentication failed using ***');
  });
});
