import { describe, expect, it } from 'vitest';
import type { Repo } from '@src/github/types';
import { publishPullRequest, UNREPORTED_WRITES, type PublishDeps } from '@src/pr/publish';
import type { PullRequest, PullRequestDraft, PullRequestPort, TicketCommentPort } from '@src/pr/types';
import type { GitPort } from '@src/vcs/types';
import { ticket } from '@tests/helpers/fakeJira';
import { fakeLogger } from '@tests/helpers/fakeLogger';

const repo: Repo = {
  name: 'developer-agent-bot',
  fullName: 'MapColonies/developer-agent-bot',
  defaultBranch: 'master',
  cloneUrl: 'https://github.com/MapColonies/developer-agent-bot.git',
};

const opened: PullRequest = { number: 7, url: 'https://github.com/MapColonies/developer-agent-bot/pull/7' };

const checks = [{ command: 'npm test', passed: true }];

/** What the agent reported writing. The default fake tree has exactly this much changed in it. */
const wrote = ['src/tiles.ts'];

/** The clone the verify slice left its diff in. The agent's own paths are absolute inside it. */
const checkout = '/workspace/clone';

/** Every effect the publish path had on the outside world, in order. Order is behaviour here. */
type Effect =
  | { kind: 'branch'; branch: string }
  | { kind: 'commit'; message: string; paths: readonly string[] }
  | { kind: 'push'; branch: string }
  | { kind: 'pull-request'; draft: PullRequestDraft }
  | { kind: 'comment'; key: string; body: string };

interface Fakes {
  readonly deps: PublishDeps;
  readonly effects: Effect[];
  readonly lines: { level: string; payload: Record<string, unknown> }[];
}

function fakes(options: { readonly changed?: readonly string[]; readonly commentFailsWith?: Error } = {}): Fakes {
  const effects: Effect[] = [];
  const { logger, lines } = fakeLogger();

  const git: GitPort = {
    root: checkout,
    changedFiles: async () => Promise.resolve(options.changed ?? ['src/tiles.ts']),
    createBranch: async (branch: string) => {
      effects.push({ kind: 'branch', branch });

      return Promise.resolve();
    },
    commit: async (message: string, paths: readonly string[]) => {
      effects.push({ kind: 'commit', message, paths });

      return Promise.resolve('a1b2c3d');
    },
    push: async (branch: string) => {
      effects.push({ kind: 'push', branch });

      return Promise.resolve();
    },
  };

  const pullRequests: PullRequestPort = {
    open: async (_: Repo, draft: PullRequestDraft) => {
      effects.push({ kind: 'pull-request', draft });

      return Promise.resolve(opened);
    },
  };

  const tickets: TicketCommentPort = {
    addComment: async (key: string, body: string) => {
      if (options.commentFailsWith) {
        throw options.commentFailsWith;
      }

      effects.push({ kind: 'comment', key, body });

      return Promise.resolve();
    },
  };

  return { deps: { git, pullRequests, tickets, logger }, effects, lines };
}

const issue = ticket({ key: 'MAPCO-11436', issueType: 'Task', summary: 'developer-agent-bot: worker builds the branch, commit and PR in code' });

describe('publishPullRequest', () => {
  it('should commit, push and open the pull request, in that order.', async () => {
    const { deps, effects } = fakes();

    const outcome = await publishPullRequest({ ticket: issue, repo, checks, wrote }, deps);

    expect(outcome).toMatchObject({
      ok: true,
      branch: 'agent/chore/MAPCO-11436-worker-builds-the-branch-commit-and-pr-in-code',
      commit: 'a1b2c3d',
      commented: true,
    });
    expect(effects.map((effect) => effect.kind)).toStrictEqual(['branch', 'commit', 'push', 'pull-request', 'comment']);
  });

  it('should derive the branch and the titles in code, from the issue type.', async () => {
    // Nothing here comes from the model: it has no git and no GitHub capability, so there is
    // nothing for it to name. A Bug gets the real type, never a flattened `chore:` — and the
    // real type is `fix:`, because `bug` is not in @map-colonies/commitlint-config's type-enum
    // and a `bug:` subject would fail the repo's own commit hook. Do not "correct" the
    // assertion below to `bug:`; the ticket's wording predates checking the org config.
    const { deps, effects } = fakes();

    await publishPullRequest(
      { ticket: ticket({ key: 'MAPCO-2', issueType: 'Bug', summary: 'developer-agent-bot: retry loop spins' }), repo, checks, wrote },
      deps
    );

    expect(effects[0]).toStrictEqual({ kind: 'branch', branch: 'agent/bug/MAPCO-2-retry-loop-spins' });
    expect(effects[2]).toStrictEqual({ kind: 'push', branch: 'agent/bug/MAPCO-2-retry-loop-spins' });
    expect(effects[1]).toMatchObject({ kind: 'commit' });
    expect((effects[1] as { message: string }).message.split('\n')[0]).toBe('fix: retry loop spins (MAPCO-2)');
  });

  it('should give the pull request the same title as the commit, so a squash merge keeps the type.', async () => {
    const { deps, effects } = fakes();

    await publishPullRequest({ ticket: issue, repo, checks, wrote }, deps);

    const commit = effects.find((effect) => effect.kind === 'commit');
    const pullRequest = effects.find((effect) => effect.kind === 'pull-request');

    expect(pullRequest?.draft.title).toBe(commit?.message.split('\n')[0]);
    expect(pullRequest?.draft.title).toBe('chore: worker builds the branch, commit and PR in code (MAPCO-11436)');
  });

  it("should open the pull request against the repo's own default branch.", async () => {
    // Half the org's repos default to `master` and half to `main`. A hard-coded base opens a
    // pull request full of somebody else's commits.
    const { deps, effects } = fakes();

    await publishPullRequest({ ticket: issue, repo: { ...repo, defaultBranch: 'main' }, checks, wrote }, deps);

    const pullRequest = effects.find((effect) => effect.kind === 'pull-request');

    expect(pullRequest?.draft.base).toBe('main');
    expect(pullRequest?.draft.head).toBe('agent/chore/MAPCO-11436-worker-builds-the-branch-commit-and-pr-in-code');
  });

  it('should link the pull request on the ticket, last of all.', async () => {
    // Last because the comment has to link a pull request that already exists.
    const { deps, effects } = fakes();

    await publishPullRequest({ ticket: issue, repo, checks, wrote }, deps);

    const comment = effects.at(-1);

    expect(comment).toMatchObject({ kind: 'comment', key: 'MAPCO-11436' });
    expect((comment as { body: string }).body).toContain(opened.url);
  });

  it('should commit only the paths the agent wrote, never the rest of the tree.', async () => {
    // The tree of a clone that has just had `npm ci` and a test suite run through it. Committing
    // all of it opens a pull request whose diff is machine-generated, under a body that says the
    // change was verified locally.
    const { deps, effects, lines } = fakes({ changed: ['package-lock.json', 'src/tiles.ts', 'coverage/lcov.info'] });

    await publishPullRequest({ ticket: issue, repo, checks, wrote }, deps);

    const commit = effects.find((effect) => effect.kind === 'commit');

    expect(commit?.paths).toStrictEqual(['src/tiles.ts']);
    expect(lines).toContainEqual({
      level: 'warn',
      payload: {
        msg: 'leaving changed paths out of the commit',
        key: 'MAPCO-11436',
        repo: 'MapColonies/developer-agent-bot',
        paths: ['package-lock.json', 'coverage/lcov.info'],
      },
    });
  });

  it('should drop a path the agent reported writing that has no diff.', async () => {
    const { deps, effects } = fakes({ changed: ['src/tiles.ts'] });

    await publishPullRequest({ ticket: issue, repo, checks, wrote: ['src/tiles.ts', 'src/untouched.ts'] }, deps);

    expect(effects.find((effect) => effect.kind === 'commit')?.paths).toStrictEqual(['src/tiles.ts']);
  });

  it("should match the agent's absolute paths against the repo-relative ones git prints.", async () => {
    // The model's `Edit` and `Write` tools report the absolute `file_path` they were given, and
    // `git status` prints repo-relative paths. Comparing the two as strings — which this slice
    // did first time round — matches nothing, stages nothing and opens no pull request, for
    // every ticket, forever.
    const { deps, effects } = fakes({ changed: ['src/tiles.ts', 'package-lock.json'] });

    await publishPullRequest({ ticket: issue, repo, checks, wrote: [`${checkout}/src/tiles.ts`, `${checkout}/./src/nope.ts`] }, deps);

    expect(effects.find((effect) => effect.kind === 'commit')?.paths).toStrictEqual(['src/tiles.ts']);
  });

  it('should ignore a reported write that is not inside the checkout, and name it.', async () => {
    const { deps, effects, lines } = fakes({ changed: ['src/tiles.ts'] });

    await publishPullRequest({ ticket: issue, repo, checks, wrote: ['src/tiles.ts', '../elsewhere/thing.ts', '/etc/passwd'] }, deps);

    expect(effects.find((effect) => effect.kind === 'commit')?.paths).toStrictEqual(['src/tiles.ts']);
    expect(lines).toContainEqual({
      level: 'warn',
      payload: {
        msg: 'ignoring reported writes outside the checkout',
        key: 'MAPCO-11436',
        repo: 'MapColonies/developer-agent-bot',
        paths: ['../elsewhere/thing.ts', '/etc/passwd'],
      },
    });
  });

  it('should commit every changed path when no write list can be reported, and say so.', async () => {
    // Nothing in the repository can produce a write list today: `AgentRun` reports a boolean and
    // `wroteFiles()` throws every `file_path` away (MAPCO-11435). Requiring the list would mean
    // every ticket publishing with `[]`, refusing as `nothing-the-agent-wrote`, and no pull
    // request ever being opened — so the sentinel is a state the caller can state, the diff is
    // unfiltered, and both the log line and the body say which of the two produced it.
    const { deps, effects, lines } = fakes({ changed: ['src/tiles.ts', 'package-lock.json'] });

    const outcome = await publishPullRequest({ ticket: issue, repo, checks, wrote: UNREPORTED_WRITES }, deps);

    expect(outcome).toMatchObject({ ok: true });
    expect(effects.find((effect) => effect.kind === 'commit')?.paths).toStrictEqual(['src/tiles.ts', 'package-lock.json']);
    expect(lines).toContainEqual({
      level: 'warn',
      payload: {
        msg: 'committing every changed path: no write list was reported',
        key: 'MAPCO-11436',
        repo: 'MapColonies/developer-agent-bot',
        paths: ['src/tiles.ts', 'package-lock.json'],
      },
    });

    const pullRequest = effects.find((effect) => effect.kind === 'pull-request');

    expect(pullRequest?.draft.body).toContain('Every file that differed in the checkout is in this diff.');
  });

  it('should tell the reviewer when the diff was filtered by a write list.', async () => {
    const { deps, effects } = fakes();

    await publishPullRequest({ ticket: issue, repo, checks, wrote }, deps);

    const pullRequest = effects.find((effect) => effect.kind === 'pull-request');

    expect(pullRequest?.draft.body).toContain('Only the files the agent reported writing');
  });

  it('should refuse when the only changes are ones the agent did not write.', async () => {
    // A repo that commits no lockfile gets a `package-lock.json` written into it by the verify
    // slice. A dirty tree is not evidence that the model did anything.
    const { deps, effects } = fakes({ changed: ['package-lock.json'] });

    const outcome = await publishPullRequest({ ticket: issue, repo, checks, wrote: [] }, deps);

    expect(outcome).toStrictEqual({ ok: false, reason: 'nothing-the-agent-wrote' });
    expect(effects).toStrictEqual([]);
  });

  it('should refuse to open an empty pull request when the tree is clean.', async () => {
    // No diff means the verify slice produced nothing. A pull request with no changes costs a
    // reviewer the time it takes to find that out.
    const { deps, effects } = fakes({ changed: [] });

    const outcome = await publishPullRequest({ ticket: issue, repo, checks, wrote }, deps);

    expect(outcome).toStrictEqual({ ok: false, reason: 'nothing-to-commit' });
    expect(effects).toStrictEqual([]);
  });

  it('should keep the pull request when the ticket comment fails.', async () => {
    // The pull request exists and is reviewable. A Jira outage in the last half-second must not
    // turn a published result into a failed one — but it is reported, not swallowed.
    const { deps, effects, lines } = fakes({ commentFailsWith: new Error('jira is down') });

    const outcome = await publishPullRequest({ ticket: issue, repo, checks, wrote }, deps);

    expect(outcome).toMatchObject({ ok: true, commented: false, pullRequest: opened });
    expect(effects.map((effect) => effect.kind)).toStrictEqual(['branch', 'commit', 'push', 'pull-request']);
    expect(lines.at(-1)).toMatchObject({ level: 'warn', payload: { msg: 'pull request opened but not linked on the ticket' } });
  });

  it('should let a push failure through rather than reporting a pull request that does not exist.', async () => {
    const { deps } = fakes();
    const failing: PublishDeps = { ...deps, git: { ...deps.git, push: async () => Promise.reject(new Error('permission denied')) } };

    await expect(publishPullRequest({ ticket: issue, repo, checks, wrote }, failing)).rejects.toThrow('permission denied');
  });
});
