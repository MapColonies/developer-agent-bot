import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import type { Repo } from '@src/github/types';
import { CliGit, CREDENTIAL_FROM_ENV, GitGuardError, TOKEN_ENV } from '@src/vcs/cliGit';
import type { TokenProvider } from '@src/vcs/types';

/**
 * The acceptance criterion "pushing to master, merging and approving are attempted in a scratch
 * repo and observed to fail", run rather than argued.
 *
 * Everything here is real: a real `git init --bare` remote, a real working tree, real hooks, the
 * real `CliGit` talking to the real `git` binary. Nothing is mocked, because the whole point of
 * the criterion is that the guards hold against git itself and not against a fake that agrees
 * with them. It also caught two defects a mocked spec could not: the clone's own `commit-msg`
 * hook killing every commit, and `git add --all` sweeping tool output into the diff.
 *
 * It lives under `tests/unit` deliberately. The `integration` project is the `runCycle` seam,
 * and this depends on nothing outside this slice and no network — only on `git` being on PATH,
 * which is a hard requirement of the slice anyway.
 */

const run = promisify(execFile);

const identity = { name: 'mapcolonies-developer-agent[bot]', email: '1234+mapcolonies-developer-agent[bot]@users.noreply.github.com' };

/** Every hook a target repo could plausibly have installed, each one refusing everything. */
const HOSTILE_HOOKS = ['pre-commit', 'commit-msg', 'prepare-commit-msg', 'pre-push'];

const roots: string[] = [];

interface Scratch {
  /** The working tree, as the verify slice would have left it. */
  readonly work: string;
  /** A bare repository standing in for GitHub. */
  readonly remote: string;
  readonly repo: Repo;
  readonly tokens: TokenProvider & { readonly minted: string[] };
  readonly git: CliGit;
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd });

  return stdout;
}

/** Commit in the setup as a human would, with an identity but without the worker's guards. */
async function humanCommit(work: string, message: string): Promise<void> {
  await git(['-c', 'user.name=Human', '-c', 'user.email=human@example.com', '-c', 'commit.gpgsign=false', 'commit', '--message', message], work);
}

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

/**
 * A fresh repository pair per test, so no test depends on what another one pushed.
 *
 * The hooks are installed the way the verify slice installs them for us by accident: `npm ci` in
 * the clone runs `prepare`, which runs husky, which puts the target repo's own `pre-commit` and
 * `commit-msg` in the checkout. Here every one of them exits 1, which is the worst case a real
 * repo can present, and the publish path has to survive it.
 *
 * `prepare-commit-msg` is in the list because of what this spec found: `git commit --no-verify`,
 * the first fix attempted for the hook problem, bypasses `pre-commit` and `commit-msg` only, and
 * this test failed until `CliGit` stopped relying on it and pointed `core.hooksPath` at nothing.
 */
async function scratch(): Promise<Scratch> {
  const root = await mkdtemp(join(tmpdir(), 'agent-scratch-'));
  roots.push(root);

  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  const hooks = join(root, 'hooks');

  await git(['init', '--bare', '--initial-branch=master', remote], root);
  await git(['init', '--initial-branch=master', work], root);

  await writeFile(join(work, 'README.md'), '# scratch\n');
  await mkdir(join(work, 'src'));
  await writeFile(join(work, 'src', 'tiles.ts'), 'export const tiles = 1;\n');
  await git(['add', '--all'], work);
  await humanCommit(work, 'chore: initial');
  await git(['push', remote, 'refs/heads/master:refs/heads/master'], work);

  await mkdir(hooks);
  for (const hook of HOSTILE_HOOKS) {
    const path = join(hooks, hook);

    await writeFile(path, '#!/bin/sh\necho "this repo refuses machine commits" >&2\nexit 1\n');
    await chmod(path, 0o755);
  }
  // Absolute, so nothing in the caller's global git config can move it.
  await git(['config', 'core.hooksPath', hooks], work);

  const repo: Repo = {
    name: 'scratch',
    fullName: 'MapColonies/scratch',
    defaultBranch: 'master',
    cloneUrl: pathToFileURL(remote).href,
  };
  const tokens = fakeTokens();

  return { work, remote, repo, tokens, git: new CliGit({ cwd: work, repo, identity, tokens }) };
}

/**
 * `git credential fill`, driven exactly as `CliGit.push` drives its credential helper.
 *
 * `execFile` rather than the promisified form, because the request goes in on stdin and the
 * promisified wrapper hands back no child to write to.
 */
async function credentialFill(cwd: string, env: NodeJS.ProcessEnv, request: string): Promise<{ stdout: string; argv: string[] }> {
  const argv = [...CREDENTIAL_FROM_ENV, 'credential', 'fill'];

  return new Promise<{ stdout: string; argv: string[] }>((resolve, reject) => {
    const child = execFile('git', argv, { cwd, env }, (err, stdout) => {
      if (err) {
        reject(err instanceof Error ? err : new Error('git credential fill failed'));

        return;
      }

      resolve({ stdout, argv });
    });

    child.stdin?.end(request);
  });
}

/** The sha a ref points at in the bare remote, or null when the remote has no such ref. */
async function remoteSha(remote: string, ref: string): Promise<string | null> {
  const stdout = await git(['ls-remote', remote, ref], remote);
  const [line] = stdout.split('\n');

  return line === undefined || line.trim() === '' ? null : (line.split('\t')[0] ?? null);
}

describe('the worker against a real repository', () => {
  afterAll(async () => {
    await Promise.all(roots.map(async (root) => rm(root, { recursive: true, force: true })));
  });

  it('should refuse every attempt to write the default branch, before git or a token is involved.', async () => {
    const { git: subject, remote, tokens } = await scratch();
    const before = await remoteSha(remote, 'refs/heads/master');

    // Every spelling of "put this on master" the caller could reach for.
    await expect(subject.push('master')).rejects.toThrow(GitGuardError);
    await expect(subject.push('refs/heads/master')).rejects.toThrow(GitGuardError);
    await expect(subject.push('agent/../master')).rejects.toThrow(GitGuardError);
    await expect(subject.push('agent/feat/x/../../../master')).rejects.toThrow(GitGuardError);
    await expect(subject.push('HEAD')).rejects.toThrow(GitGuardError);
    await expect(subject.push('--mirror')).rejects.toThrow(GitGuardError);
    await expect(subject.createBranch('master')).rejects.toThrow(GitGuardError);

    // Refused in code, so no credential was ever minted for any of it.
    expect(tokens.minted).toStrictEqual([]);
    await expect(remoteSha(remote, 'refs/heads/master')).resolves.toBe(before);
  });

  it('should fail every attempt to merge, approve, force or delete, and leave master where it was.', async () => {
    // The other half of the criterion, attempted rather than described. Each call is made
    // through a loose record so that asking `CliGit` to merge is a runtime question instead of a
    // compile error — a capability that does not exist can only be "observed to fail" if
    // something actually tries to use it.
    const { git: subject, work, remote } = await scratch();
    const masterBefore = await remoteSha(remote, 'refs/heads/master');
    const loose = subject as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;

    for (const act of ['merge', 'rebase', 'approve', 'review', 'forcePush', 'deleteBranch', 'reset', 'tag']) {
      expect(loose[act]).toBeUndefined();
      expect(() => (loose[act] as (...args: unknown[]) => unknown)('master')).toThrow(TypeError);
    }

    // The surface is the whole of it: four members, none of which is any of the above, so a
    // later slice cannot reach for one by accident either.
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(subject) as object).filter((name) => name !== 'constructor');

    expect([...surface].sort()).toStrictEqual(['changedFiles', 'commit', 'createBranch', 'push']);

    // And the only route to master the surface does have refuses, so nothing moved: not the
    // remote's master, and not the local checkout either.
    await expect(subject.push('master')).rejects.toThrow(GitGuardError);
    await expect(remoteSha(remote, 'refs/heads/master')).resolves.toBe(masterBefore);
    await expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], work)).resolves.toBe('master\n');
  });

  it('should commit a filename that looks like a glob, because git stages it without complaint.', async () => {
    // `app/[id]/page.tsx` is an ordinary file in a Next.js-shaped repository, and the first
    // version of this slice refused to commit any path containing `[`, `]`, `*`, `?` or a
    // backslash — a ticket on such a repo could never be published, and it burned an attempt
    // against the MAPCO-11432 cap on the way. Run against the real git binary, because the
    // question was always what git does rather than what the guard believes.
    const { git: subject, work } = await scratch();
    const globbish = 'app/[id]/page.tsx';

    await mkdir(join(work, 'app', '[id]'), { recursive: true });
    await writeFile(join(work, globbish), 'export default function Page() {}\n');
    await subject.createBranch('agent/feat/MAPCO-1-render-the-page');

    const sha = await subject.commit('feat: render the page (MAPCO-1)', [globbish]);

    await expect(git(['show', '--pretty=format:', '--name-only', sha], work)).resolves.toBe(`${globbish}\n`);
    await expect(subject.changedFiles()).resolves.toStrictEqual([]);
  });

  it('should commit and push the agent branch even when every hook in the clone refuses.', async () => {
    const { git: subject, work, remote, tokens } = await scratch();
    const branch = 'agent/chore/MAPCO-11436-worker-builds-the-branch';
    const masterBefore = await remoteSha(remote, 'refs/heads/master');

    // What the verify slice leaves behind: the model's edit, plus the `package-lock.json` that
    // `npm install` writes into a repo which does not commit one and does not gitignore it.
    await writeFile(join(work, 'src', 'tiles.ts'), 'export const tiles = 2;\n');
    await writeFile(join(work, 'package-lock.json'), '{ "lockfileVersion": 3 }\n');
    // A new file in a directory that did not exist before, which porcelain collapses to `sld/`
    // unless it is asked not to.
    await mkdir(join(work, 'sld'));
    await writeFile(join(work, 'sld', 'parse.ts'), 'export const parse = 1;\n');

    const changed = await subject.changedFiles();

    expect(changed).toContain('src/tiles.ts');
    expect(changed).toContain('sld/parse.ts');
    expect(changed).toContain('package-lock.json');

    await subject.createBranch(branch);
    const sha = await subject.commit('chore: worker builds the branch (MAPCO-11436)', ['src/tiles.ts', 'sld/parse.ts']);
    await subject.push(branch);

    // The commit exists, is authored by the App, and contains only what the agent wrote — the
    // generated lockfile is still sitting in the working tree, uncommitted and unpushed.
    expect(sha).toMatch(/^[0-9a-f]{40}$/u);
    await expect(git(['show', '--pretty=format:', '--name-only', sha], work)).resolves.toBe(`sld/parse.ts\nsrc/tiles.ts\n`);
    await expect(subject.changedFiles()).resolves.toStrictEqual(['package-lock.json']);
    await expect(git(['log', '-1', '--format=%an <%ae>'], work)).resolves.toBe(`${identity.name} <${identity.email}>\n`);

    // The branch arrived on the remote, under `agent/`, and master did not move.
    await expect(remoteSha(remote, `refs/heads/${branch}`)).resolves.toBe(sha);
    await expect(remoteSha(remote, 'refs/heads/master')).resolves.toBe(masterBefore);
    expect(tokens.minted).toStrictEqual(['ghs-token-1']);
  });

  it('should leave the identity out of the checkout so the next ticket cannot inherit it.', async () => {
    const { git: subject, work } = await scratch();

    await writeFile(join(work, 'src', 'tiles.ts'), 'export const tiles = 3;\n');
    await subject.createBranch('agent/chore/MAPCO-1-do-the-thing');
    await subject.commit('chore: do the thing (MAPCO-1)', ['src/tiles.ts']);

    // `git config user.name` in a container is shared by every ticket that container handles.
    await expect(git(['config', '--local', '--get-regexp', '^user\\.'], work).catch(() => 'unset')).resolves.toBe('unset');
  });

  it('should give the real git the minted token through the environment and never in its argv.', async () => {
    // The token used to be interpolated into the push URL, where `/proc/<pid>/cmdline` makes it
    // readable by every process on the host — including a same-user one the model can arrange
    // through the clone's own test script. This is the replacement, run against the real git:
    // the helper in the argv names a variable, git executes it, and the value comes back out of
    // the environment. Asserting the string alone would prove nothing about what `sh -c` does
    // with it.
    const { work } = await scratch();
    const token = 'ghs-token-under-test';

    const { stdout, argv } = await credentialFill(
      work,
      /* eslint-disable-next-line @typescript-eslint/naming-convention -- git's own environment variable */
      { ...process.env, [TOKEN_ENV]: token, GIT_TERMINAL_PROMPT: '0' },
      'protocol=https\nhost=github.com\n\n'
    );

    expect(stdout).toContain('username=x-access-token');
    expect(stdout).toContain(`password=${token}`);
    expect(argv.some((arg) => arg.includes(token))).toBe(false);
  });

  it('should report the checkout it works in, so an absolute path can be made relative to it.', async () => {
    // The publish path matches the agent's absolute `file_path`s against git's repo-relative
    // output, and the root is the only thing that can turn one into the other.
    const { git: subject, work } = await scratch();

    expect(subject.root).toBe(work);
  });

  it('should refuse a path that tries to climb out of the checkout.', async () => {
    const { git: subject, work } = await scratch();

    await writeFile(join(work, 'src', 'tiles.ts'), 'export const tiles = 4;\n');
    await subject.createBranch('agent/chore/MAPCO-1-do-the-thing');

    await expect(subject.commit('chore: x (MAPCO-1)', ['../outside.ts'])).rejects.toThrow(GitGuardError);
    await expect(subject.commit('chore: x (MAPCO-1)', ['.git/config'])).rejects.toThrow(GitGuardError);
    await expect(subject.commit('chore: x (MAPCO-1)', [])).rejects.toThrow(GitGuardError);

    // Nothing was staged by the attempts, so the tree is still exactly as the agent left it.
    await expect(git(['diff', '--cached', '--name-only'], work)).resolves.toBe('');
  });
});
