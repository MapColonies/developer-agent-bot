import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import type { Repo } from '@src/github/types';
import { CloneRefusedError, CloneWorkspace } from '@src/vcs/clone';
import { TOKEN_ENV, type RunGit } from '@src/vcs/gitInvoke';
import type { TokenProvider } from '@src/vcs/types';
import { fakeLogger } from '@tests/helpers/fakeLogger';

/**
 * MAPCO-11433's "the repo is cloned at its default branch into an ephemeral workspace" and "the
 * workspace is cleaned up on every path", run rather than argued.
 *
 * The clone half is real: a real `git init --bare` remote with two branches, the real `git`
 * binary, the real filesystem. A fake that agreed with the worker about what `--branch` does
 * would prove nothing, and the interesting assertion — that the checkout is on the branch
 * GitHub named rather than the one git would have picked — is only true of real git.
 *
 * The credential half is driven through an injected runner instead, because what matters there
 * is what git is *handed*: the token must be in the child's environment and never in its argv,
 * and argv is the thing a spec can read.
 */

const run = promisify(execFile);

const TOKEN = 'ghs_atokenthatlookslikeatoken';

const roots: string[] = [];

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-bot-clone-'));
  roots.push(root);

  return root;
}

/** A bare repository whose HEAD is `main`, with the real work on `release`. */
async function remoteWithTwoBranches(): Promise<{ url: string; defaultBranch: string }> {
  const root = await scratchRoot();
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');

  await run('git', ['init', '--bare', '--initial-branch=main', remote]);
  await run('git', ['init', '--initial-branch=main', work]);
  await writeFile(join(work, 'on-main.txt'), 'main\n');
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: work });
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'main'], { cwd: work });
  await run('git', ['checkout', '-b', 'release'], { cwd: work });
  await writeFile(join(work, 'on-release.txt'), 'release\n');
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: work });
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'release'], { cwd: work });
  await run('git', ['push', remote, 'main', 'release'], { cwd: work });

  return { url: pathToFileURL(remote).href, defaultBranch: 'release' };
}

function repoAt(cloneUrl: string, defaultBranch = 'release'): Repo {
  return { name: 'some-service', fullName: 'MapColonies/some-service', defaultBranch, cloneUrl };
}

const tokens: TokenProvider = { mint: async (): Promise<string> => Promise.resolve(TOKEN) };

/** A provider that records whether it was asked, so a refusal can be shown to mint nothing. */
function countingTokens(): TokenProvider & { minted: number } {
  const counter = { minted: 0, mint: async (): Promise<string> => Promise.resolve(TOKEN) };

  return {
    get minted(): number {
      return counter.minted;
    },
    mint: async (): Promise<string> => {
      counter.minted += 1;

      return counter.mint();
    },
  };
}

/** Records every git invocation, so a spec can read the argv and the environment it was given. */
function recordingGit(fail?: Error): RunGit & { calls: { args: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv }[] } {
  const calls: { args: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv }[] = [];
  const recorder = async (args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> => {
    calls.push({ args, cwd, env });

    if (fail) {
      throw fail;
    }

    return Promise.resolve('');
  };

  return Object.assign(recorder, { calls });
}

function workspaceFor(options: { root: string; run?: RunGit; tokens?: TokenProvider }): CloneWorkspace {
  return new CloneWorkspace({
    root: options.root,
    tokens: options.tokens ?? tokens,
    run: options.run,
    logger: fakeLogger().logger,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
}

describe('CloneWorkspace', () => {
  afterAll(async () => {
    await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
  });

  it('should clone the branch GitHub called default, not the one git would have chosen.', async () => {
    // The assertion the ticket actually asks for. The remote's own HEAD is `main`; a clone that
    // simply took the remote's default would check out the wrong branch, and every pull request
    // the worker opened would be based on it.
    const { url, defaultBranch } = await remoteWithTwoBranches();
    const workspace = await workspaceFor({ root: await scratchRoot() }).create(repoAt(url, defaultBranch));

    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspace.dir });

    expect(stdout.trim()).toBe('release');
    await expect(exists(join(workspace.dir, 'on-release.txt'))).resolves.toBe(true);
  });

  it('should leave the clone in a directory of its own, so two tickets cannot share one.', async () => {
    const { url } = await remoteWithTwoBranches();
    const root = await scratchRoot();
    const workspaces = workspaceFor({ root });

    const [first, second] = await Promise.all([workspaces.create(repoAt(url)), workspaces.create(repoAt(url))]);

    expect(first.dir).not.toBe(second.dir);
  });

  it('should remove the whole workspace when it is disposed.', async () => {
    const { url } = await remoteWithTwoBranches();
    const root = await scratchRoot();
    const workspace = await workspaceFor({ root }).create(repoAt(url));

    await workspace.dispose();

    await expect(exists(workspace.dir)).resolves.toBe(false);
    // The root it was made under survives: in the pod that is a mounted volume, not ours to delete.
    await expect(readdir(root)).resolves.toStrictEqual([]);
  });

  it('should survive being disposed twice, because the cleanup runs on every path.', async () => {
    // `dispose` is called from a `finally`, and a second call is the ordinary consequence of a
    // caller that tidies up early and then unwinds.
    const { url } = await remoteWithTwoBranches();
    const workspace = await workspaceFor({ root: await scratchRoot() }).create(repoAt(url));

    await workspace.dispose();

    await expect(workspace.dispose()).resolves.toBeUndefined();
  });

  it('should leave nothing behind when the clone itself fails.', async () => {
    // The path that would otherwise fill the pod's disk one failed ticket at a time: the
    // directory is made before git runs, so a failure has to clean up after itself.
    const root = await scratchRoot();
    const workspaces = workspaceFor({ root });

    await expect(workspaces.create(repoAt(pathToFileURL(join(root, 'no-such-repo.git')).href))).rejects.toThrow();

    await expect(readdir(root)).resolves.toStrictEqual([]);
  });

  it('should leave nothing behind when the credential cannot be minted.', async () => {
    // The same disk-filling path as a failed clone, one step earlier: `mint` throws on a missing
    // `GITHUB_TOKEN`, so a directory made before it is one no `catch` in `create` would remove.
    const root = await scratchRoot();
    const failing: TokenProvider = {
      mint: async (): Promise<string> => Promise.reject(new Error('GITHUB_TOKEN is not set')),
    };
    const workspaces = workspaceFor({ root, run: recordingGit(), tokens: failing });

    await expect(workspaces.create(repoAt('https://github.com/MapColonies/some-service.git'))).rejects.toThrow('GITHUB_TOKEN');

    await expect(readdir(root)).resolves.toStrictEqual([]);
  });

  it('should hand the credential to git through the environment, never in its argv.', async () => {
    // argv is world-readable through `/proc/<pid>/cmdline`; the environment is readable by the
    // process owner alone. A token in the clone's argv is one any process on the host can read.
    const git = recordingGit();
    await workspaceFor({ root: await scratchRoot(), run: git }).create(repoAt('https://github.com/MapColonies/some-service.git'));

    const [call] = git.calls;

    expect(call?.args.join(' ')).not.toContain(TOKEN);
    expect(call?.env?.[TOKEN_ENV]).toBe(TOKEN);
  });

  it('should ask for a shallow, single-branch clone, because a ticket needs no history.', async () => {
    const git = recordingGit();
    await workspaceFor({ root: await scratchRoot(), run: git }).create(repoAt('https://github.com/MapColonies/some-service.git'));

    expect(git.calls[0]?.args).toEqual(expect.arrayContaining(['--depth', '1', '--single-branch', '--branch', 'release']));
  });

  it('should refuse a remote that is not the configured GitHub host, without minting anything.', async () => {
    // The credential helper answers for whatever host git asks about, so a remote nobody
    // vetted is a token handed to it. Refused before the mint, so there is nothing to hand over.
    const minting = countingTokens();
    const workspaces = workspaceFor({ root: await scratchRoot(), run: recordingGit(), tokens: minting });

    await expect(workspaces.create(repoAt('https://evil.example/MapColonies/some-service.git'))).rejects.toThrow(CloneRefusedError);
    expect(minting.minted).toBe(0);
  });

  it('should refuse a remote whose scheme could carry a credential somewhere else.', async () => {
    const workspaces = workspaceFor({ root: await scratchRoot(), run: recordingGit() });

    await expect(workspaces.create(repoAt('ssh://github.com/MapColonies/some-service.git'))).rejects.toThrow(CloneRefusedError);
  });

  it('should keep the token out of the message when the clone fails.', async () => {
    // git echoes the remote back on failure, and a token in a log line outlives the token.
    const git = recordingGit(new Error(`fatal: could not read Password for 'https://x-access-token:${TOKEN}@github.com'`));
    const workspaces = workspaceFor({ root: await scratchRoot(), run: git });

    await expect(workspaces.create(repoAt('https://github.com/MapColonies/some-service.git'))).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(TOKEN) as unknown as string })
    );
  });
});
