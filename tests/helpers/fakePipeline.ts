import type { Logger } from '@map-colonies/js-logger';
import type { ImplementDeps } from '@src/agent/implement';
import type { Implementer } from '@src/agent/implementer';
import type { AgentLimits, AgentPort, AgentRun, AgentRunRequest, DescriptionPort } from '@src/agent/types';
import type { GitHubPort, Repo } from '@src/github/types';
import type { PullRequest, PullRequestDraft, PullRequestPort } from '@src/pr/types';
import type { GitPort, Workspace, WorkspacePort } from '@src/vcs/types';
import type { TestPlan, TestPlanResult, TestRun, TestRunner } from '@src/workspace/types';

/**
 * Doubles for the edges of the pipeline, and nothing inside it.
 *
 * Everything faked here is a thing outside the process: GitHub's API, the model, the git binary,
 * the clone on disk, a repository's own test suite. Everything between them — `runCycle`, the
 * claim, the budget guard, the hand-back latch, `implementTicket`, `publishPullRequest` — is the
 * real code in the integration suite, because those are what the wiring is about. A fake of any
 * of them would be a fake that agrees with the wiring.
 *
 * Each double records what it was asked for, so a spec can assert on observable outcomes — which
 * is the convention MAPCO-11434 asks for by name: Jira mutations, workspace state, claimed or
 * released, never on an internal call count for its own sake.
 */

const DEFAULT_TEST_COMMAND = 'npm run test:ci';

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    name: 'some-service',
    fullName: 'MapColonies/some-service',
    defaultBranch: 'master',
    cloneUrl: 'https://github.com/MapColonies/some-service.git',
    ...overrides,
  };
}

/** GitHub's repo lookup. Answers for the names it was given and `null` for anything else. */
function fakeGitHub(repos: readonly Repo[] = [repo()]): GitHubPort & { looked: string[] } {
  const looked: string[] = [];
  const known = new Map(repos.map((known) => [known.name.toLowerCase(), known]));

  return {
    looked,
    findRepo: async (name: string): Promise<Repo | null> => {
      looked.push(name);

      return Promise.resolve(known.get(name.toLowerCase()) ?? null);
    },
  };
}

interface FakeWorkspaces extends WorkspacePort {
  /** Repos a clone was asked for, in order. */
  readonly cloned: Repo[];
  /** Directories that were disposed of. Every created one must end up here. */
  readonly disposed: string[];
  /** Directories created and not yet disposed. Non-empty at the end of a cycle is a leak. */
  readonly live: () => string[];
}

/**
 * The clone, as a directory name and a promise to forget it.
 *
 * No real checkout: the agent and the test runner are doubles too, so nothing in the integration
 * suite reads the directory. What the suite does assert is that one was made for the right repo,
 * that the model was pointed at it, and that it was disposed of on every path — which is
 * MAPCO-11433's acceptance criterion and needs only the bookkeeping. The real `git clone` has its
 * own spec against a real bare repository (tests/unit/vcs/clone.spec.ts).
 */
function fakeWorkspaces(options: { failWith?: Error } = {}): FakeWorkspaces {
  const cloned: Repo[] = [];
  const disposed: string[] = [];
  const made: string[] = [];

  return {
    cloned,
    disposed,
    live: (): string[] => made.filter((dir) => !disposed.includes(dir)),
    create: async (target: Repo): Promise<Workspace> => {
      cloned.push(target);

      if (options.failWith) {
        throw options.failWith;
      }

      const dir = `/workspace/${target.name}-${made.length}`;
      made.push(dir);

      return Promise.resolve({
        dir,
        dispose: async (): Promise<void> => {
          disposed.push(dir);

          return Promise.resolve();
        },
      });
    },
  };
}

function agentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    outcome: 'changed',
    usage: { input: 1_000, output: 200, cacheRead: 0, costUsd: 0.05 },
    turns: 6,
    summary: 'added the retry',
    deniedTools: [],
    ...overrides,
  };
}

/**
 * The model. Hands out queued runs and repeats the last one rather than running dry, so a spec
 * that only cares about the first hand-off need not queue three.
 */
function fakeAgent(runs: readonly AgentRun[] = [agentRun()]): AgentPort & { requests: AgentRunRequest[] } {
  const requests: AgentRunRequest[] = [];
  const queue = [...runs];

  return {
    requests,
    run: async (request: AgentRunRequest): Promise<AgentRun> => {
      requests.push(request);

      return Promise.resolve((queue.length > 1 ? queue.shift() : queue[0]) ?? agentRun());
    },
  };
}

const plan: TestPlan = {
  script: 'test:ci',
  command: DEFAULT_TEST_COMMAND,
  executed: { 'test:ci': 'vitest run' },
  dependencies: '[]',
};

/** A repository's own suite. Repeats its last answer, for the same reason `fakeAgent` does. */
function fakeTests(
  runs: readonly TestRun[] = [{ ok: true, command: DEFAULT_TEST_COMMAND, output: 'all green' }],
  planned: TestPlanResult = { ok: true, plan }
): TestRunner & { dirs: string[] } {
  const dirs: string[] = [];
  const queue = [...runs];

  return {
    dirs,
    plan: async (): Promise<TestPlanResult> => Promise.resolve(planned),
    run: async (dir: string): Promise<TestRun> => {
      dirs.push(dir);

      return Promise.resolve((queue.length > 1 ? queue.shift() : queue[0]) ?? { ok: true, command: DEFAULT_TEST_COMMAND, output: '' });
    },
  };
}

interface FakeGit extends GitPort {
  readonly branches: string[];
  readonly commits: { message: string; paths: readonly string[] }[];
  readonly pushes: string[];
}

/** git inside the clone, without a checkout. The real guards have their own specs. */
function fakeGit(options: { cwd: string; changed?: readonly string[]; failWith?: Error }): FakeGit {
  const branches: string[] = [];
  const commits: { message: string; paths: readonly string[] }[] = [];
  const pushes: string[] = [];

  return {
    root: options.cwd,
    branches,
    commits,
    pushes,
    changedFiles: async (): Promise<readonly string[]> => Promise.resolve(options.changed ?? ['src/fetch.ts']),
    createBranch: async (branch: string): Promise<void> => {
      branches.push(branch);

      return Promise.resolve();
    },
    commit: async (message: string, paths: readonly string[]): Promise<string> => {
      commits.push({ message, paths });

      return Promise.resolve('c0ffee1');
    },
    push: async (branch: string): Promise<void> => {
      if (options.failWith) {
        throw options.failWith;
      }

      pushes.push(branch);

      return Promise.resolve();
    },
  };
}

/** GitHub's pull-request API. */
function fakePullRequests(options: { failWith?: Error } = {}): PullRequestPort & { opened: { repo: Repo; draft: PullRequestDraft }[] } {
  const opened: { repo: Repo; draft: PullRequestDraft }[] = [];

  return {
    opened,
    open: async (target: Repo, draft: PullRequestDraft): Promise<PullRequest> => {
      if (options.failWith) {
        throw options.failWith;
      }

      opened.push({ repo: target, draft });

      return Promise.resolve({ number: 42, url: `https://github.com/${target.fullName}/pull/42` });
    },
  };
}

/**
 * The implement step, assembled from doubles.
 *
 * Mirrors what `createImplementer` does — including applying the per-ticket `meter` — rather than
 * calling it, because that function's whole job is to construct the *real* agent from the pod's
 * model credential. That it wires the meter and the hand-back through correctly is asserted in
 * `tests/unit/agent/implementer.spec.ts`; what the integration suite needs is the same shape with
 * a model that costs nothing.
 */
function fakeImplementer(parts: {
  agent: AgentPort;
  tests: TestRunner;
  description: DescriptionPort;
  logger: Logger;
  limits: AgentLimits;
}): Implementer {
  return (scope): ImplementDeps => ({
    agent: scope.meter === undefined ? parts.agent : scope.meter(parts.agent),
    tests: parts.tests,
    description: parts.description,
    release: scope.release,
    logger: parts.logger,
    limits: parts.limits,
  });
}

export { agentRun, DEFAULT_TEST_COMMAND, fakeAgent, fakeGit, fakeGitHub, fakeImplementer, fakePullRequests, fakeTests, plan, repo, fakeWorkspaces };
export type { FakeGit, FakeWorkspaces };
