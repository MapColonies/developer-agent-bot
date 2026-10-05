import { describe, expect, it } from 'vitest';
import { AgentConfigError } from '@src/agent/credential';
import { DEFAULT_AGENT_LIMITS } from '@src/agent/implement';
import type { WorkerConfig } from '@src/common/workerConfig';
import { TokenError } from '@src/vcs/envToken';
import { createWorker, limitsFor } from '@src/worker';
import { FakeJira } from '@tests/helpers/fakeJira';
import { fakeLogger } from '@tests/helpers/fakeLogger';

/**
 * The lifetimes, which are the only thing this file decides.
 *
 * Two of the three have already been the subject of a defect — a spend total that never reset,
 * and a hand-back latch shared where it had to be per ticket — so they are asserted rather than
 * argued in a comment.
 */

/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */
const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', MODEL_AUTH: 'api-key', ANTHROPIC_API_KEY: 'sk-from-the-secret', GITHUB_TOKEN: 'ghp_atoken' };
/* eslint-enable @typescript-eslint/naming-convention */

const config: WorkerConfig = {
  pollIntervalMs: 1000,
  maxTicketsPerRun: 1,
  maxConcurrentTickets: 1,
  mcpUrl: 'http://mcp.invalid',
  bot: { account: 'developer-agent@mapcolonies.example', displayName: 'AGENT DEVELOPER' },
  workspaceRoot: '/workspace',
  commitIdentity: { name: 'developer-agent[bot]', email: 'developer-agent[bot]@users.noreply.github.com' },
};

function worker(overrides: Partial<WorkerConfig> = {}): ReturnType<typeof createWorker> {
  return createWorker({ jira: new FakeJira(), logger: fakeLogger().logger, config: { ...config, ...overrides }, env });
}

describe('limitsFor', () => {
  it('should bound one hand-off by the per-ticket turn ceiling.', () => {
    // No hand-off may go further than the whole ticket is permitted; the cumulative total across
    // hand-offs is the ledger's job, which is what `meterAgent` charges.
    const limits = limitsFor({ ...config, budget: { ticket: { maxTokens: 1_000, maxTurns: 12 }, maxTicketsPerDay: 5 } });

    expect(limits).toStrictEqual({ maxAttempts: DEFAULT_AGENT_LIMITS.maxAttempts, maxTurns: 12 });
  });

  it('should fall back to the conservative ceilings when a config carries none.', () => {
    // `budget` is optional on the type only. Absence must read as the defaults, never as "no
    // ceiling" — see `budgetOf`.
    expect(limitsFor(config).maxTurns).toBe(DEFAULT_AGENT_LIMITS.maxTurns);
  });
});

describe('createWorker', () => {
  it('should refuse to come up at all when the deployment supplied no model credential.', () => {
    // At boot rather than mid-cycle: a worker that discovers this on its first ticket has already
    // claimed one and has to hand it straight back.
    /* eslint-disable-next-line @typescript-eslint/naming-convention -- an environment variable name */
    const withoutKey: NodeJS.ProcessEnv = { GITHUB_TOKEN: 'ghp_atoken' };

    expect(() => createWorker({ jira: new FakeJira(), logger: fakeLogger().logger, config, env: withoutKey })).toThrow(AgentConfigError);
  });

  it('should refuse to come up when there is no GitHub credential either.', () => {
    // Discovered per ticket instead, this would cost a claim, a comment and an attempt on every
    // ticket in the queue — and two of those retire a ticket from it.
    // `MODEL_AUTH` is explicit so the model credential passes and the GitHub one is what is
    // missing. Left off, `sdk` is the default and this would refuse for the wrong reason.
    /* eslint-disable-next-line @typescript-eslint/naming-convention -- environment variable names */
    const withoutToken: NodeJS.ProcessEnv = { MODEL_AUTH: 'api-key', ANTHROPIC_API_KEY: 'sk-from-the-secret' };

    expect(() => createWorker({ jira: new FakeJira(), logger: fakeLogger().logger, config, env: withoutToken })).toThrow(TokenError);
  });

  it('should hand out a fresh hand-back latch per ticket.', () => {
    // The latch is what stops a ticket being handed back twice; sharing one between tickets
    // would refuse the *next* legitimate hand-back instead.
    const deps = worker();

    expect(deps.handBack()).not.toBe(deps.handBack());
  });

  it('should hold one budget guard for the process, because the daily counter is the day’s.', () => {
    const deps = worker();

    expect(deps.budget).toBe(deps.budget);
  });

  it('should open a separate cycle each run, so a spend total cannot outlive the line it is on.', () => {
    const deps = worker();

    expect(deps.budget.cycle()).not.toBe(deps.budget.cycle());
  });

  it('should report nothing spent on a cycle that has charged nothing.', () => {
    expect(deps(worker()).tokensSpent).toBe(0);
  });

  it('should carry the configured ceilings onto the run line.', () => {
    expect(deps(worker({ budget: { ticket: { maxTokens: 10, maxTurns: 2 }, maxTicketsPerDay: 3 } })).dailyCapLimit).toBe(3);
  });
});

/** The budget half of a fresh cycle's run line. */
function deps(built: ReturnType<typeof createWorker>): Record<string, number | boolean> {
  return built.budget.cycle().runLine() as unknown as Record<string, number | boolean>;
}
