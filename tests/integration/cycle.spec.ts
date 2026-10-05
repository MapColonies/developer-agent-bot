import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_LIMITS } from '@src/agent/implement';
import type { AgentRun } from '@src/agent/types';
import { createBudgetGuard } from '@src/budget/guard';
import type { AbortPort, AbortResult, BudgetConfig } from '@src/budget/types';
import { runCycle, type CycleDeps } from '@src/cycle';
import { createDelivery } from '@src/deliver';
import type { Repo } from '@src/github/types';
import { createDescriptionReader } from '@src/jira/description';
import type { JiraTicket, JiraTransition } from '@src/jira/types';
import { handBackTicket } from '@src/tickets/handBack';
import { createHandBackOnce, type HandBackOnce } from '@src/tickets/handBackOnce';
import type { WorkerConfig } from '@src/common/workerConfig';
import type { TestRun } from '@src/workspace/types';
import { FakeJira, ticket, type FakeWrite } from '@tests/helpers/fakeJira';
import { fakeLogger, type RecordedLine } from '@tests/helpers/fakeLogger';
import {
  agentRun,
  DEFAULT_TEST_COMMAND,
  fakeAgent,
  fakeGit,
  fakeGitHub,
  fakeImplementer,
  fakePullRequests,
  fakeTests,
  fakeWorkspaces,
  repo,
  type FakeGit,
  type FakeWorkspaces,
} from '@tests/helpers/fakePipeline';

const BOT_ACCOUNT = 'developer-agent@mapcolonies.example';
const BOT_DISPLAY_NAME = 'AGENT DEVELOPER';
const DESCRIPTION = 'The fetch helper gives up on the first 503. Make it retry three times.';

const baseConfig: WorkerConfig = {
  pollIntervalMs: 1000,
  maxTicketsPerRun: 1,
  maxConcurrentTickets: 1,
  mcpUrl: 'http://mcp.invalid',
  bot: { account: BOT_ACCOUNT, displayName: BOT_DISPLAY_NAME },
  workspaceRoot: '/workspace',
  commitIdentity: { name: 'developer-agent[bot]', email: 'developer-agent[bot]@users.noreply.github.com' },
};

const displayNames = { [BOT_ACCOUNT]: BOT_DISPLAY_NAME };

/** A realistic workflow: transitions named as verbs, each reporting the status it lands in. */
function workflowFor(...keys: string[]): Record<string, JiraTransition[]> {
  return Object.fromEntries(
    keys.map((key) => [
      key,
      [
        { id: '21', name: 'Start Progress', to: 'In Progress' },
        { id: '11', name: 'Reopen', to: 'Open' },
      ],
    ])
  );
}

/** A ticket the pipeline can actually work: a resolvable repo prefix and prose to work from. */
function workableTicket(overrides: Partial<JiraTicket> = {}): JiraTicket {
  return ticket({ summary: 'some-service: retry the fetch helper', description: DESCRIPTION, ...overrides });
}

interface Pipeline {
  readonly deps: CycleDeps;
  readonly lines: RecordedLine[];
  readonly jira: FakeJira;
  readonly workspaces: FakeWorkspaces;
  readonly github: ReturnType<typeof fakeGitHub>;
  readonly agent: ReturnType<typeof fakeAgent>;
  readonly tests: ReturnType<typeof fakeTests>;
  readonly pullRequests: ReturnType<typeof fakePullRequests>;
  /** The git doubles handed out, one per clone. */
  readonly gits: FakeGit[];
}

interface PipelineOptions {
  readonly config?: Partial<WorkerConfig>;
  readonly repos?: readonly Repo[];
  readonly runs?: readonly AgentRun[];
  readonly testRuns?: readonly TestRun[];
  readonly noTestCommand?: boolean;
  readonly cloneFailsWith?: Error;
  readonly pushFailsWith?: Error;
  readonly openFailsWith?: Error;
  readonly changed?: readonly string[];
  readonly budget?: BudgetConfig;
}

/**
 * The whole worker, with doubles only at the edges.
 *
 * `runCycle`, the claim, the budget guard, the hand-back latch, `implementTicket` and
 * `publishPullRequest` are the real thing — this is the seam the repository's test strategy is
 * built around, and the point of these cases is that the real modules compose.
 */
function pipeline(jira: FakeJira, options: PipelineOptions = {}): Pipeline {
  const { logger, lines } = fakeLogger();
  const config: WorkerConfig = { ...baseConfig, ...options.config };

  const github = fakeGitHub(options.repos ?? [repo()]);
  const workspaces = fakeWorkspaces(options.cloneFailsWith === undefined ? {} : { failWith: options.cloneFailsWith });
  const agent = fakeAgent(options.runs ?? [agentRun()]);
  const tests = fakeTests(
    options.testRuns ?? [{ ok: true, command: DEFAULT_TEST_COMMAND, output: 'all green' }],
    options.noTestCommand === true ? { ok: false, reason: 'no-command', output: 'no test script' } : undefined
  );
  const pullRequests = fakePullRequests(options.openFailsWith === undefined ? {} : { failWith: options.openFailsWith });
  const gits: FakeGit[] = [];

  const handBackDeps = { jira, logger, attemptCap: 2 };
  const abort: AbortPort = {
    abort: async (target: JiraTicket, note: string): Promise<AbortResult> => handBackTicket(target, note, handBackDeps),
  };

  const delivery = createDelivery({
    github,
    workspaces,
    implementer: fakeImplementer({ agent, tests, description: createDescriptionReader(jira), logger, limits: DEFAULT_AGENT_LIMITS }),
    pullRequests,
    tickets: jira,
    git: ({ cwd }): FakeGit => {
      const git = fakeGit({
        cwd,
        ...(options.changed === undefined ? {} : { changed: options.changed }),
        ...(options.pushFailsWith === undefined ? {} : { failWith: options.pushFailsWith }),
      });
      gits.push(git);

      return git;
    },
    logger,
  });

  const deps: CycleDeps = {
    jira,
    logger,
    config,
    delivery,
    budget: createBudgetGuard({
      budget: options.budget ?? { ticket: { maxTokens: 1_000_000, maxTurns: 1_000 }, maxTicketsPerDay: 5 },
      abort,
      logger,
    }),
    handBack: (): HandBackOnce => createHandBackOnce(handBackDeps),
  };

  return { deps, lines, jira, workspaces, github, agent, tests, pullRequests, gits };
}

function kindsOf(writes: FakeWrite[]): string[] {
  return writes.map((write) => write.kind);
}

function commentsOn(writes: FakeWrite[]): string[] {
  return writes.filter((write) => write.kind === 'comment').map((write) => write.body);
}

function labelWrites(writes: FakeWrite[]): readonly string[][] {
  return writes.filter((write) => write.kind === 'labels').map((write) => [...write.labels]);
}

/** The order tickets appear in the write log, collapsed — `[a, b]` means a finished before b started. */
function ticketRuns(writes: FakeWrite[]): string[] {
  return writes.map((write) => write.key).filter((key, index, keys) => key !== keys[index - 1]);
}

function runLine(lines: RecordedLine[]): Record<string, unknown> {
  return lines.filter((line) => line.payload.msg === 'cycle complete').at(-1)?.payload ?? {};
}

describe('runCycle', () => {
  describe('the whole pipeline', () => {
    it('should turn an agent-ready ticket into a pull request linked on the ticket.', async () => {
      // MAPCO-11436's Expected Result, through the seam: a ticket goes in and a reviewable pull
      // request comes out, on an `agent/`-prefixed branch, linked from a comment.
      const jira = new FakeJira({ tickets: [workableTicket({ key: 'MAPCO-100' })], transitions: workflowFor('MAPCO-100'), displayNames });
      const { deps, pullRequests, gits, lines } = pipeline(jira);

      const result = await runCycle(deps);

      expect(result).toMatchObject({ found: 1, started: 1, skipped: 0, outcome: 'ok' });
      expect(gits[0]?.pushes).toStrictEqual(['agent/chore/MAPCO-100-retry-the-fetch-helper']);
      expect(pullRequests.opened[0]?.draft).toMatchObject({
        head: 'agent/chore/MAPCO-100-retry-the-fetch-helper',
        base: 'master',
        title: 'chore: retry the fetch helper (MAPCO-100)',
      });
      expect(commentsOn(jira.writes).at(-1)).toContain('https://github.com/MapColonies/some-service/pull/42');
      expect(lines.some((line) => line.payload.msg === 'pull request opened for ticket')).toBe(true);
    });

    it('should hand the ticket to the model inside the clone, with the prose a human wrote.', async () => {
      // MAPCO-11434's "the ticket is handed to the Agent SDK as the task, working inside the
      // clone" — which is the wiring itself, and which nothing could assert before.
      const jira = new FakeJira({ tickets: [workableTicket({ key: 'MAPCO-101' })], transitions: workflowFor('MAPCO-101'), displayNames });
      const { deps, agent, workspaces } = pipeline(jira);

      await runCycle(deps);

      expect(agent.requests[0]?.task).toStrictEqual({
        key: 'MAPCO-101',
        summary: 'some-service: retry the fetch helper',
        description: DESCRIPTION,
      });
      expect(agent.requests[0]?.workdir).toBe(workspaces.cloned.length > 0 ? `/workspace/some-service-0` : '');
    });

    it('should clone the repository the title names, at the branch GitHub calls default.', async () => {
      // MAPCO-11433: the repo comes from the `<repo-name>: ` prefix and is confirmed to exist.
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps, github, workspaces } = pipeline(jira, { repos: [repo({ defaultBranch: 'main' })] });

      await runCycle(deps);

      expect(github.looked).toStrictEqual(['some-service']);
      expect(workspaces.cloned).toStrictEqual([repo({ defaultBranch: 'main' })]);
    });

    it('should run the suite in the clone before anything is pushed.', async () => {
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps, tests, workspaces } = pipeline(jira);

      await runCycle(deps);

      expect(tests.dirs).toStrictEqual(['/workspace/some-service-0']);
      expect(workspaces.disposed).toStrictEqual(['/workspace/some-service-0']);
    });

    it('should say in the pull request what it actually ran.', async () => {
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps, pullRequests } = pipeline(jira);

      await runCycle(deps);

      expect(pullRequests.opened[0]?.draft.body).toContain(DEFAULT_TEST_COMMAND);
    });

    it('should keep hold of a ticket whose pull request is open, rather than releasing it.', async () => {
      // The work is done and a human is reviewing it. Releasing would put the ticket back in the
      // poll's way and let the worker do it all again.
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps } = pipeline(jira);

      await runCycle(deps);

      await expect(jira.getIssue('MAPCO-1')).resolves.toMatchObject({ assignee: BOT_DISPLAY_NAME });
      expect(labelWrites(jira.writes)).toStrictEqual([]);
    });

    it('should clean the workspace up on every path, including a failed push.', async () => {
      // MAPCO-11433's "the workspace is cleaned up on every path". A publish failure throws by
      // design, and a worker that leaked a clone per thrown ticket would fill the volume.
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps, workspaces } = pipeline(jira, { pushFailsWith: new Error('remote hung up') });

      await runCycle(deps);

      expect(workspaces.live()).toStrictEqual([]);
    });
  });

  describe('refusing a ticket it cannot work', () => {
    it('should refuse a title that names no repository, without cloning anything.', async () => {
      const jira = new FakeJira({ tickets: [ticket({ summary: 'make the thing faster' })], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps, workspaces } = pipeline(jira);

      await runCycle(deps);

      expect(workspaces.cloned).toStrictEqual([]);
      expect(commentsOn(jira.writes)[0]).toContain('Could not tell which repository this ticket is about');
    });

    it('should count the attempt when it refuses, so the same ticket is not re-burnt for ever.', async () => {
      const jira = new FakeJira({ tickets: [ticket({ summary: 'no prefix here' })], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps } = pipeline(jira);

      await runCycle(deps);

      expect(labelWrites(jira.writes)).toStrictEqual([['agent-ready', 'agent-attempted-1']]);
      await expect(jira.getIssue('MAPCO-1')).resolves.toMatchObject({ assignee: null });
    });

    it('should refuse a repository that does not exist, naming what it looked for.', async () => {
      const jira = new FakeJira({
        tickets: [workableTicket({ summary: 'ghost-service: do the thing' })],
        transitions: workflowFor('MAPCO-1'),
        displayNames,
      });
      const { deps } = pipeline(jira);

      await runCycle(deps);

      expect(commentsOn(jira.writes)[0]).toContain('ghost-service');
    });

    it('should refuse a ticket with no description before the model is paid for.', async () => {
      // The blocker this wiring had to close: `DescriptionPort` had no implementation, so the
      // honest stub answered `''` for every ticket and `implementTicket` refused all of them.
      const jira = new FakeJira({ tickets: [workableTicket({ description: '' })], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps, agent } = pipeline(jira);

      await runCycle(deps);

      expect(agent.requests).toStrictEqual([]);
      expect(commentsOn(jira.writes)[0]).toContain('This ticket has no description');
    });

    it('should work a ticket that does have a description, which is the case that used to fail.', async () => {
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps, agent } = pipeline(jira);

      await runCycle(deps);

      expect(agent.requests).toHaveLength(1);
    });

    it('should refuse a repository that states no test command, rather than pushing unverified work.', async () => {
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps, agent, pullRequests } = pipeline(jira, { noTestCommand: true });

      await runCycle(deps);

      expect(agent.requests).toStrictEqual([]);
      expect(pullRequests.opened).toStrictEqual([]);
      expect(commentsOn(jira.writes)[0]).toContain('could not be verified in this repository');
    });

    it('should hand a ticket back when the repository cannot be cloned, and say it may not be the ticket.', async () => {
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps } = pipeline(jira, { cloneFailsWith: new Error('repository not found') });

      await runCycle(deps);

      expect(commentsOn(jira.writes)[0]).toContain('could not be cloned');
      expect(commentsOn(jira.writes)[0]).toContain('may be the repository or the network rather than the ticket');
      expect(labelWrites(jira.writes)).toStrictEqual([['agent-ready', 'agent-attempted-1']]);
    });

    it('should take the existing release path when the suite keeps failing.', async () => {
      // MAPCO-11434's "repeated test failure, after a bounded number of attempts, takes the
      // existing release path" — comment, release, bump the attempt count.
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps, agent, pullRequests } = pipeline(jira, {
        testRuns: [{ ok: false, reason: 'failed', command: DEFAULT_TEST_COMMAND, output: '1 failed' }],
      });

      await runCycle(deps);

      expect(agent.requests).toHaveLength(DEFAULT_AGENT_LIMITS.maxAttempts);
      expect(pullRequests.opened).toStrictEqual([]);
      expect(commentsOn(jira.writes)[0]).toContain('did not pass');
      expect(labelWrites(jira.writes)).toStrictEqual([['agent-ready', 'agent-attempted-1']]);
      await expect(jira.getIssue('MAPCO-1')).resolves.toMatchObject({ assignee: null });
    });

    it('should open no pull request when the verified tree has nothing in it.', async () => {
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps, pullRequests } = pipeline(jira, { changed: [] });

      await runCycle(deps);

      expect(pullRequests.opened).toStrictEqual([]);
      expect(commentsOn(jira.writes)[0]).toContain('no change to offer');
    });

    it('should hand a held ticket back when the publish throws, rather than holding it for ever.', async () => {
      // There is no boot-time orphan sweep yet (MAPCO-11432), so a ticket dropped here would stay
      // assigned to the bot and invisible to the poll — lost rather than contained.
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps, lines } = pipeline(jira, { openFailsWith: new Error('422 unprocessable') });

      const result = await runCycle(deps);

      expect(result).toMatchObject({ started: 1 });
      expect(lines.some((line) => line.level === 'error' && line.payload.msg === 'ticket failed')).toBe(true);
      expect(commentsOn(jira.writes)[0]).toContain('stopped part-way through with an error');
      await expect(jira.getIssue('MAPCO-1')).resolves.toMatchObject({ assignee: null });
    });
  });

  describe('spend ceilings', () => {
    it('should stop a ticket that runs out of its token budget and say what it cost.', async () => {
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps, pullRequests } = pipeline(jira, {
        budget: { ticket: { maxTokens: 500, maxTurns: 1_000 }, maxTicketsPerDay: 5 },
      });

      await runCycle(deps);

      expect(pullRequests.opened).toStrictEqual([]);
      expect(commentsOn(jira.writes)[0]).toContain('ran out of the budget I am allowed to spend on one ticket');
      expect(commentsOn(jira.writes)[0]).toContain('1,200 tokens');
    });

    it('should hand an overspent ticket back exactly once, however many give-up paths fire.', async () => {
      // The invariant `createHandBackOnce` exists for: the budget aborts mid-hand-off and the
      // stopped run is then reported as a give-up, which would otherwise comment a second time on
      // a ticket already back in Open that a human may have picked up.
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps } = pipeline(jira, { budget: { ticket: { maxTokens: 500, maxTurns: 1_000 }, maxTicketsPerDay: 5 } });

      await runCycle(deps);

      expect(commentsOn(jira.writes)).toHaveLength(1);
      expect(labelWrites(jira.writes)).toHaveLength(1);
      expect(jira.writes.filter((write) => write.kind === 'assign' && write.assignee === null)).toHaveLength(1);
    });

    it('should stop a ticket that runs out of its turn budget, counted in model turns.', async () => {
      // Not one turn per hand-off: the run reports six, and a ceiling of five must stop it.
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps } = pipeline(jira, { budget: { ticket: { maxTokens: 1_000_000, maxTurns: 5 }, maxTicketsPerDay: 5 } });

      await runCycle(deps);

      expect(commentsOn(jira.writes)[0]).toContain('6 turns');
    });

    it('should poll and start nothing once the day is used up.', async () => {
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps, lines } = pipeline(jira, { budget: { ticket: { maxTokens: 1_000_000, maxTurns: 1_000 }, maxTicketsPerDay: 1 } });

      await runCycle(deps);
      const second = await runCycle(deps);

      expect(second).toMatchObject({ found: 1, started: 0, skipped: 1, outcome: 'ok' });
      expect(runLine(lines)).toMatchObject({ dailyCapReached: true, ticketsStartedToday: 1 });
    });

    it('should write nothing at all on a run that has hit the daily cap.', async () => {
      // A ticket claimed and then dropped for a spend ceiling has already put a bot's name on a
      // human's ticket and notified its watchers.
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps } = pipeline(jira, { budget: { ticket: { maxTokens: 1_000_000, maxTurns: 1_000 }, maxTicketsPerDay: 1 } });

      await runCycle(deps);
      const before = jira.writes.length;
      await runCycle(deps);

      expect(jira.writes).toHaveLength(before);
    });

    it("should report the cycle's own spend on the run line, not a hard-coded zero.", async () => {
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps, lines } = pipeline(jira);

      await runCycle(deps);

      expect(runLine(lines)).toMatchObject({ tokensSpent: 1_200, turnsSpent: 6, ticketsStartedToday: 1, dailyCapLimit: 5 });
    });

    it("should report each cycle's spend separately, not the process's running total.", async () => {
      // The defect a single long-lived guard caused: the spend never reset, so a per-cycle field
      // carried the lifetime total and any sum over those lines double-counted. The two counters
      // on the same line have deliberately different lifetimes — the spend is the cycle's, the
      // daily count is the process's — so a second cycle that starts nothing has to show one
      // reset and the other not.
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps, lines } = pipeline(jira);

      await runCycle(deps);

      expect(runLine(lines)).toMatchObject({ tokensSpent: 1_200, ticketsStartedToday: 1 });

      // The ticket is still held, with its pull request open, so this cycle claims nothing.
      await runCycle(deps);

      expect(runLine(lines)).toMatchObject({ tokensSpent: 0, turnsSpent: 0, ticketsStartedToday: 1 });
    });
  });

  describe('claiming and the poll', () => {
    it('should leave a refused ticket unassigned again, so the next run can pick it up.', async () => {
      const jira = new FakeJira({ tickets: [ticket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps } = pipeline(jira);

      await runCycle(deps);

      await expect(jira.getIssue('MAPCO-1')).resolves.toMatchObject({ assignee: null });
    });

    it('should not touch a ticket that turns out to be assigned by the time it is reached.', async () => {
      // The poll query filters `assignee is EMPTY`, so this is the snapshot-went-stale case
      // rather than something the query would hand over — it exercises the guard before the write.
      const jira = new FakeJira({ tickets: [workableTicket({ assignee: 'BROCHSTEIN RAZ' })], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps } = pipeline(jira);

      const result = await runCycle(deps);

      expect(result).toMatchObject({ found: 1, started: 0, skipped: 1 });
      expect(jira.writes).toStrictEqual([]);
    });

    it('should back off cleanly when a human claims the ticket mid-claim.', async () => {
      const jira = new FakeJira({
        tickets: [workableTicket()],
        transitions: workflowFor('MAPCO-1'),
        displayNames,
        stealOnAssign: 'BROCHSTEIN RAZ',
      });
      const { deps, lines, workspaces } = pipeline(jira);

      const result = await runCycle(deps);

      expect(result).toMatchObject({ started: 0, skipped: 1, outcome: 'ok' });
      // The assign is already out there; the point is that nothing follows it — no transition,
      // no comment, no clone, and no attempt to take it back off the human.
      expect(kindsOf(jira.writes)).toStrictEqual(['assign']);
      expect(workspaces.cloned).toStrictEqual([]);
      expect(lines.some((line) => line.level === 'warn' && line.payload.reason === 'lost-race' && line.payload.saw === 'BROCHSTEIN RAZ')).toBe(true);
    });

    it('should report the transitions a workflow did offer when it cannot claim.', async () => {
      // The real transition vocabulary is unverified, so a refusal has to say what it saw
      // rather than leaving a silent no-op to be discovered by a drained queue.
      const jira = new FakeJira({
        tickets: [workableTicket()],
        transitions: { 'MAPCO-1': [{ id: '31', name: 'Reject', to: 'Rejected' }] },
        displayNames,
      });
      const { deps, lines } = pipeline(jira);

      const result = await runCycle(deps);

      expect(result).toMatchObject({ started: 0, skipped: 1 });
      expect(lines.some((line) => line.payload.reason === 'no-transition' && (line.payload.offered as string[])[0] === 'Reject')).toBe(true);
    });

    it('should honour the per-run ticket limit and say there is more waiting.', async () => {
      const keys = ['MAPCO-1', 'MAPCO-2', 'MAPCO-3'];
      const jira = new FakeJira({ tickets: keys.map((key) => workableTicket({ key })), transitions: workflowFor(...keys), displayNames });
      const { deps } = pipeline(jira, { config: { maxTicketsPerRun: 2, maxConcurrentTickets: 2 } });

      const result = await runCycle(deps);

      expect(result.found).toBe(2);
      expect(result.started).toBe(2);
      expect(result.more).toBe(true);
      // One over the limit, because the server's `total` is always -1 and cannot be trusted.
      expect(jira.queries[0]?.limit).toBe(3);
      expect(jira.writes.some((write) => write.key === 'MAPCO-3')).toBe(false);
    });

    it('should hold tickets to one at a time at the default concurrency.', async () => {
      const keys = ['MAPCO-1', 'MAPCO-2'];
      const jira = new FakeJira({ tickets: keys.map((key) => workableTicket({ key })), transitions: workflowFor(...keys), displayNames });
      const { deps } = pipeline(jira, { config: { maxTicketsPerRun: 2, maxConcurrentTickets: 1 } });

      await runCycle(deps);

      // Each ticket is finished with before the next is touched: the cap is what stops the
      // worker holding a whole page of tickets at once.
      expect(ticketRuns(jira.writes)).toStrictEqual(['MAPCO-1', 'MAPCO-2']);
    });

    it('should give each concurrent ticket a workspace of its own.', async () => {
      // Two tickets sharing a clone would have the model of one reading the half-finished change
      // of the other, and the publish path committing both.
      const keys = ['MAPCO-1', 'MAPCO-2'];
      const jira = new FakeJira({ tickets: keys.map((key) => workableTicket({ key })), transitions: workflowFor(...keys), displayNames });
      const { deps, agent } = pipeline(jira, { config: { maxTicketsPerRun: 2, maxConcurrentTickets: 2 } });

      await runCycle(deps);

      expect(new Set(agent.requests.map((request) => request.workdir)).size).toBe(2);
    });

    it('should not claim there is more waiting when the queue is exhausted.', async () => {
      const jira = new FakeJira({ tickets: [workableTicket()], transitions: workflowFor('MAPCO-1'), displayNames });
      const { deps } = pipeline(jira);

      expect((await runCycle(deps)).more).toBe(false);
    });

    it('should report an empty queue rather than treating it as a failure.', async () => {
      const jira = new FakeJira({ tickets: [] });
      const { deps, lines } = pipeline(jira);

      const result = await runCycle(deps);

      expect(result).toMatchObject({ found: 0, started: 0, outcome: 'ok' });
      expect(lines[0]?.level).toBe('info');
    });

    it('should survive a poll failure and report it, so the schedule keeps running.', async () => {
      const jira = new FakeJira({ failWith: new Error('mcp unreachable') });
      const { deps, lines } = pipeline(jira);

      const result = await runCycle(deps);

      expect(result.outcome).toBe('failed');
      expect(lines[0]?.level).toBe('error');
    });

    it('should keep hold of a ticket it cannot return to Open, and say so loudly.', async () => {
      const jira = new FakeJira({
        tickets: [ticket({ summary: 'no prefix, so it is refused' })],
        transitions: { 'MAPCO-1': [{ id: '21', name: 'Start Progress', to: 'In Progress' }] },
        displayNames,
      });
      const { deps, lines } = pipeline(jira);

      const result = await runCycle(deps);

      // It did hold the ticket, so it counts as started — but it is now stuck, and the run
      // line has to make that findable.
      expect(result).toMatchObject({ started: 1, outcome: 'ok' });
      await expect(jira.getIssue('MAPCO-1')).resolves.toMatchObject({ assignee: BOT_DISPLAY_NAME });
      expect(lines.some((line) => line.payload.msg === 'ticket not delivered' && line.payload.handedBack === false)).toBe(true);
    });

    it('should let one broken ticket fail without taking the run down with it.', async () => {
      const keys = ['MAPCO-1', 'MAPCO-2'];
      const jira = new FakeJira({
        tickets: keys.map((key) => workableTicket({ key })),
        transitionsFailWith: new Error('jira exploded'),
        displayNames,
      });
      const { deps, lines } = pipeline(jira, { config: { maxTicketsPerRun: 2 } });

      const result = await runCycle(deps);

      expect(result).toMatchObject({ found: 2, started: 0, skipped: 2, outcome: 'ok' });
      expect(lines.filter((line) => line.payload.msg === 'ticket failed')).toHaveLength(2);
    });

    it('should write nothing to a ticket it never managed to claim.', async () => {
      // The claim threw before the worker held anything, so the failure path must not comment on
      // or count a ticket that is still somebody else's to pick up.
      const keys = ['MAPCO-1'];
      const jira = new FakeJira({
        tickets: keys.map((key) => workableTicket({ key })),
        transitionsFailWith: new Error('jira exploded'),
        displayNames,
      });
      const { deps } = pipeline(jira);

      await runCycle(deps);

      expect(jira.writes).toStrictEqual([]);
    });
  });
});
