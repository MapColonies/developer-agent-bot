import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_LIMITS, implementTicket, type ImplementDeps } from '@src/agent/implement';
import type {
  AgentLimits,
  AgentPort,
  AgentRun,
  AgentRunRequest,
  Assignment,
  DescriptionPort,
  ReleasePort,
  ReleaseResult,
  TokenUsage,
} from '@src/agent/types';
import type { TestPlan, TestPlanResult, TestRun, TestRunner } from '@src/workspace/types';
import { ticket } from '@tests/helpers/fakeJira';
import { fakeLogger } from '@tests/helpers/fakeLogger';

const WORKDIR = '/workspace/some-service';

const assignment: Assignment = { ticket: ticket({ key: 'MAPCO-77' }), workdir: WORKDIR };
const DESCRIPTION = 'Make the retry actually retry.';

/**
 * The ticket's prose, as a port the wiring slice still owes an implementation of.
 *
 * Given a `string` it answers with it; given an `Error` it throws, which is what a Jira read
 * failing looks like from in here.
 */
function fakeDescription(answer: string | Error = DESCRIPTION): DescriptionPort & { asked: string[] } {
  const asked: string[] = [];

  return {
    asked,
    read: async (read): Promise<string> => {
      asked.push(read.key);

      if (answer instanceof Error) {
        throw answer;
      }

      return Promise.resolve(answer);
    },
  };
}

function usage(input: number): TokenUsage {
  return { input, output: 1, cacheRead: 0, costUsd: 0.5 };
}

function changed(input = 100): AgentRun {
  return { outcome: 'changed', usage: usage(input), summary: 'edited the helper', deniedTools: [] };
}

/** Hands out queued runs and refuses to invent one, so an over-run of the bound fails loudly. */
function fakeAgent(runs: (AgentRun | Error)[]): AgentPort & { requests: AgentRunRequest[] } {
  const requests: AgentRunRequest[] = [];
  const queue = [...runs];

  return {
    requests,
    run: async (request: AgentRunRequest): Promise<AgentRun> => {
      requests.push(request);

      const next = queue.shift();

      if (next === undefined) {
        throw new Error(`the agent was run more times than the bound allows (${requests.length})`);
      }

      if (next instanceof Error) {
        throw next;
      }

      return Promise.resolve(next);
    },
  };
}

const PLAN: TestPlan = { script: 'test', command: 'npm run test', executed: { test: 'vitest run' }, dependencies: '[]' };

/**
 * Records the plans it was asked for and the plans it was run with, so a spec can assert that
 * the command a run was graded by is the one read off the pristine clone.
 */
function fakeTests(runs: TestRun[], planned: TestPlanResult = { ok: true, plan: PLAN }): TestRunner & { dirs: string[]; ran: TestPlan[] } {
  const dirs: string[] = [];
  const ran: TestPlan[] = [];
  const queue = [...runs];

  return {
    dirs,
    ran,
    plan: async (): Promise<TestPlanResult> => Promise.resolve(planned),
    run: async (dir: string, plan: TestPlan): Promise<TestRun> => {
      dirs.push(dir);
      ran.push(plan);

      const next = queue.shift();

      if (next === undefined) {
        throw new Error(`the tests were run more times than expected (${dirs.length})`);
      }

      return Promise.resolve(next);
    },
  };
}

interface Handback {
  readonly key: string;
  readonly note: string;
}

function fakeRelease(outcome: ReleaseResult = { ok: true }): ReleasePort & { handbacks: Handback[] } {
  const handbacks: Handback[] = [];

  return {
    handbacks,
    handBack: async (released, note): Promise<ReleaseResult> => {
      handbacks.push({ key: released.key, note });

      return Promise.resolve(outcome);
    },
  };
}

const PASSED: TestRun = { ok: true, command: 'npm run test', output: '12 passed' };
const FAILED: TestRun = { ok: false, reason: 'failed', command: 'npm run test', output: 'AssertionError: expected 2 retries, got 1' };

function deps(
  agent: AgentPort,
  tests: TestRunner,
  release: ReleasePort,
  limits: AgentLimits = DEFAULT_AGENT_LIMITS,
  description: DescriptionPort = fakeDescription()
): ImplementDeps & { lines: ReturnType<typeof fakeLogger>['lines'] } {
  const { logger, lines } = fakeLogger();

  return { agent, tests, description, release, logger, limits, lines };
}

describe('implementTicket', () => {
  it("should count the work as done only once the repository's own tests pass.", async () => {
    const agent = fakeAgent([changed()]);
    const tests = fakeTests([PASSED]);
    const release = fakeRelease();

    const result = await implementTicket(assignment, deps(agent, tests, release));

    expect(result).toMatchObject({ ok: true, attempts: 1, command: 'npm run test' });
    // The tests ran in the clone, and the ticket was never handed back.
    expect(tests.dirs).toStrictEqual([WORKDIR]);
    expect(release.handbacks).toStrictEqual([]);
  });

  it('should never verify a change the model did not make.', async () => {
    const agent = fakeAgent([{ outcome: 'no-change', usage: usage(10), summary: 'nothing to do', deniedTools: [] }]);
    const tests = fakeTests([]);
    const release = fakeRelease();

    const result = await implementTicket(assignment, deps(agent, tests, release));

    expect(result).toMatchObject({ ok: false, reason: 'no-change', attempts: 1, released: true });
    // Nothing was run, and the bound was not spent asking the same question again.
    expect(tests.dirs).toStrictEqual([]);
    expect(agent.requests).toHaveLength(1);
  });

  it('should hand the failing output back to the model and pass on the second attempt.', async () => {
    const agent = fakeAgent([changed(100), changed(200)]);
    const tests = fakeTests([FAILED, PASSED]);
    const release = fakeRelease();

    const result = await implementTicket(assignment, deps(agent, tests, release));

    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(agent.requests[0]?.previousFailure).toBeUndefined();
    expect(agent.requests[1]?.previousFailure).toContain('AssertionError: expected 2 retries, got 1');
    expect(release.handbacks).toStrictEqual([]);
  });

  it('should take the release path once repeated test failure exhausts the bound.', async () => {
    const limits: AgentLimits = { maxAttempts: 2, maxTurns: 5 };
    const agent = fakeAgent([changed(), changed()]);
    const tests = fakeTests([FAILED, FAILED]);
    const release = fakeRelease();

    const result = await implementTicket(assignment, deps(agent, tests, release, limits));

    expect(result).toMatchObject({ ok: false, reason: 'tests-failing', attempts: 2, released: true });
    // Exactly the bound, no more: the model is handed the ticket twice and the suite runs twice.
    expect(agent.requests).toHaveLength(2);
    expect(tests.dirs).toHaveLength(2);
    expect(release.handbacks.map((handback) => handback.key)).toStrictEqual(['MAPCO-77']);
  });

  it('should say on the ticket what failed and that nothing was pushed.', async () => {
    const limits: AgentLimits = { maxAttempts: 1, maxTurns: 5 };
    const release = fakeRelease();

    await implementTicket(assignment, deps(fakeAgent([changed()]), fakeTests([FAILED]), release, limits));

    const note = release.handbacks[0]?.note ?? '';

    expect(note).toContain('npm run test');
    expect(note).toContain('AssertionError: expected 2 retries, got 1');
    expect(note).toContain('Nothing was pushed and no branch was created');
    expect(note).toContain('1 attempt.');
  });

  it('should refuse a repository it cannot verify before it pays for a single model run.', async () => {
    // No test command is not a failing suite: it will still be missing on the second attempt,
    // and a change nothing can test must not read as a verified one. Discovering it after the
    // model has run is a hand-off's worth of tokens spent to learn something the manifest said
    // for free.
    const noCommand: TestPlanResult = { ok: false, reason: 'no-command', output: 'Could not find a test command in package.json.' };
    const agent = fakeAgent([]);
    const tests = fakeTests([], noCommand);
    const release = fakeRelease();

    const result = await implementTicket(assignment, deps(agent, tests, release));

    expect(result).toMatchObject({ ok: false, reason: 'not-verifiable', attempts: 0, released: true });
    expect(agent.requests).toStrictEqual([]);
    expect(tests.dirs).toStrictEqual([]);
    expect(release.handbacks[0]?.note).toContain('Could not find a test command');
  });

  it('should grade every attempt by the command read off the clone, not by the manifest as it stands.', async () => {
    const agent = fakeAgent([changed(), changed()]);
    const tests = fakeTests([FAILED, PASSED]);

    await implementTicket(assignment, deps(agent, tests, fakeRelease()));

    // Same plan both times: nothing re-reads the test command between attempts, which is what
    // would otherwise let the model rewrite the command that grades it.
    expect(tests.ran).toStrictEqual([PLAN, PLAN]);
  });

  it('should stop and say so when the change rewrote the command that grades it.', async () => {
    // Not a test failure and not the repository's fault — asking the model again is not an
    // answer to it, and a person should see it on the ticket.
    const tampered: TestRun = {
      ok: false,
      reason: 'verification-changed',
      command: 'npm run test',
      output: 'The change edited package.json scripts that the worker runs to verify it: test.',
    };
    const agent = fakeAgent([changed()]);
    const release = fakeRelease();

    const result = await implementTicket(assignment, deps(agent, fakeTests([tampered]), release));

    expect(result).toMatchObject({ ok: false, reason: 'verification-changed', attempts: 1, released: true });
    expect(agent.requests).toHaveLength(1);
    expect(release.handbacks[0]?.note).toContain('scripts that the worker runs to verify it: test');
    expect(release.handbacks[0]?.note).toContain('worth a look by a person');
  });

  it('should treat a broken install as unverifiable rather than as a bad change.', async () => {
    const installFailed: TestRun = { ok: false, reason: 'install-failed', command: 'npm run test', output: 'ETARGET no matching version' };
    const agent = fakeAgent([changed()]);

    const result = await implementTicket(assignment, deps(agent, fakeTests([installFailed]), fakeRelease()));

    expect(result).toMatchObject({ ok: false, reason: 'not-verifiable' });
    expect(agent.requests).toHaveLength(1);
  });

  it('should cap what it quotes on the ticket however long the failure was.', async () => {
    // A registry outage prints thousands of lines. Every other branch of the note is capped;
    // this one used to rely on the runner's own capture limit, which is a different module's
    // constant and free to change.
    const noisy: TestRun = { ok: false, reason: 'install-failed', command: 'npm run test', output: 'npm ERR! '.repeat(2_000) };
    const release = fakeRelease();

    await implementTicket(assignment, deps(fakeAgent([changed()]), fakeTests([noisy]), release));

    const note = release.handbacks[0]?.note ?? '';

    expect(note).toContain('truncated');
    expect(note.length).toBeLessThan(noisy.output.length);
  });

  it('should release the ticket when the run itself falls over, rather than leaving it claimed.', async () => {
    const agent = fakeAgent([new Error('socket hang up')]);
    const tests = fakeTests([]);
    const release = fakeRelease();
    const wired = deps(agent, tests, release);

    const result = await implementTicket(assignment, wired);

    expect(result).toMatchObject({ ok: false, reason: 'agent-error', released: true });
    expect(release.handbacks[0]?.note).toContain('socket hang up');
    expect(wired.lines.some((line) => line.level === 'error')).toBe(true);
  });

  it('should report a release that did not hold instead of throwing.', async () => {
    // Held-and-stuck is recoverable by the boot orphan sweep; a throw here would lose the run.
    const release = fakeRelease({ ok: false, reason: 'no-transition' });
    const wired = deps(fakeAgent([changed()]), fakeTests([FAILED]), release, { maxAttempts: 1, maxTurns: 5 });

    const result = await implementTicket(assignment, wired);

    expect(result).toMatchObject({ ok: false, released: false });
    expect(wired.lines.some((line) => line.level === 'error' && line.payload['msg'] === 'gave up but could not release')).toBe(true);
  });

  it('should add up what every attempt spent, including the ones that failed.', async () => {
    const agent = fakeAgent([changed(100), changed(200)]);

    const result = await implementTicket(assignment, deps(agent, fakeTests([FAILED, PASSED]), fakeRelease()));

    expect(result.usage).toStrictEqual({ input: 300, output: 2, cacheRead: 0, costUsd: 1 });
  });

  it('should give the model the turn budget it was configured with, in the clone it was given.', async () => {
    const limits: AgentLimits = { maxAttempts: 1, maxTurns: 7 };
    const agent = fakeAgent([changed()]);

    await implementTicket(assignment, deps(agent, fakeTests([PASSED]), fakeRelease(), limits));

    expect(agent.requests[0]).toMatchObject({ workdir: WORKDIR, maxTurns: 7 });
    expect(agent.requests[0]?.task).toStrictEqual({
      key: 'MAPCO-77',
      summary: 'some-service: do the thing',
      description: 'Make the retry actually retry.',
    });
  });

  it('should hand the ticket back before any model run when the ticket has no description.', async () => {
    // The whole ticket, in the words a human wrote on it, is what the model is given. A summary
    // line is not that, and asking anyway buys a hand-off whose only honest answer is "there is
    // not enough here" — at full price, on every ticket in the queue.
    const agent = fakeAgent([]);
    const tests = fakeTests([]);
    const release = fakeRelease();
    const wired = deps(agent, tests, release, DEFAULT_AGENT_LIMITS, fakeDescription(''));

    const result = await implementTicket(assignment, wired);

    expect(result).toMatchObject({ ok: false, reason: 'no-description', attempts: 0, released: true });
    expect(agent.requests).toStrictEqual([]);
    expect(tests.dirs).toStrictEqual([]);
    expect(release.handbacks[0]?.note).toContain('This ticket has no description');
  });

  it('should say so on the ticket when the description could not be read at all.', async () => {
    // A different thing from a ticket nobody wrote up, and it asks a different person to act:
    // one of these is fixed by writing a description, the other by fixing the worker.
    const release = fakeRelease();
    const wired = deps(fakeAgent([]), fakeTests([]), release, DEFAULT_AGENT_LIMITS, fakeDescription(new Error('MCP call timed out')));

    const result = await implementTicket(assignment, wired);

    expect(result).toMatchObject({ ok: false, reason: 'no-description', attempts: 0, released: true });
    expect(release.handbacks[0]?.note).toContain('MCP call timed out');
    expect(wired.lines.some((line) => line.level === 'error')).toBe(true);
  });

  it('should report the failing suite, not the empty attempt that followed it.', async () => {
    // Attempt one changes the code and the suite fails; attempt two reads the failure, decides
    // the test is right and writes nothing. The diff from attempt one is still in the working
    // tree, so a note saying the ticket was too thin to act on would be false, and it would
    // throw away the only output a person could use.
    const agent = fakeAgent([changed(), { outcome: 'no-change', usage: usage(10), summary: 'the test looks right to me', deniedTools: [] }]);
    const release = fakeRelease();

    const result = await implementTicket(assignment, deps(agent, fakeTests([FAILED]), release));

    expect(result).toMatchObject({ ok: false, reason: 'tests-failing', attempts: 2, released: true });
    expect(release.handbacks[0]?.note).toContain('AssertionError: expected 2 retries, got 1');
    expect(release.handbacks[0]?.note).not.toContain('there was not enough here to act on');
  });

  it('should keep both facts when the run fell over after a suite had already failed.', async () => {
    // An API outage is not a failing test and must not read as one, but the failure an earlier
    // attempt did produce is still the only thing on the ticket a person can act on.
    const agent = fakeAgent([changed(), new Error('socket hang up')]);
    const release = fakeRelease();

    const result = await implementTicket(assignment, deps(agent, fakeTests([FAILED]), release));

    expect(result).toMatchObject({ ok: false, reason: 'agent-error', attempts: 2 });
    expect(release.handbacks[0]?.note).toContain('socket hang up');
    expect(release.handbacks[0]?.note).toContain('AssertionError: expected 2 retries, got 1');
  });

  it('should ask for the description of the ticket it is working, and hand it over as the task.', async () => {
    const description = fakeDescription('Retry the fetch with backoff.');
    const agent = fakeAgent([changed()]);

    await implementTicket(assignment, deps(agent, fakeTests([PASSED]), fakeRelease(), DEFAULT_AGENT_LIMITS, description));

    expect(description.asked).toStrictEqual(['MAPCO-77']);
    expect(agent.requests[0]?.task).toStrictEqual({
      key: 'MAPCO-77',
      summary: 'some-service: do the thing',
      description: 'Retry the fetch with backoff.',
    });
  });

  it('should log which tools the model was refused, so a denial is visible in the pod.', async () => {
    const agent = fakeAgent([{ outcome: 'changed', usage: usage(1), summary: 'edited', deniedTools: ['Bash'] }]);
    const wired = deps(agent, fakeTests([PASSED]), fakeRelease());

    await implementTicket(assignment, wired);

    expect(wired.lines.some((line) => JSON.stringify(line.payload['denied']) === JSON.stringify(['Bash']))).toBe(true);
  });
});
