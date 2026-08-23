/* eslint-disable @typescript-eslint/naming-convention -- these are environment variable names */
import { describe, expect, it } from 'vitest';
import { budgetOf, ConfigError, DEFAULT_BUDGET, loadWorkerConfig } from '@src/common/workerConfig';

const minimal = {
  MCP_ATLASSIAN_URL: 'http://mcp-atlassian:8080/mcp',
  JIRA_BOT_ACCOUNT: 'developer-agent@mapcolonies.example',
  JIRA_BOT_DISPLAY_NAME: 'AGENT DEVELOPER',
};

describe('loadWorkerConfig', () => {
  it('should default both concurrency knobs to 1.', () => {
    const config = loadWorkerConfig(minimal);

    expect(config.maxTicketsPerRun).toBe(1);
    expect(config.maxConcurrentTickets).toBe(1);
  });

  it('should refuse to start without an MCP url, since it has no Jira credentials of its own.', () => {
    expect(() => loadWorkerConfig({})).toThrow(ConfigError);
  });

  it('should refuse a nonsense limit rather than quietly coercing it.', () => {
    expect(() => loadWorkerConfig({ ...minimal, MAX_TICKETS_PER_RUN: '0' })).toThrow(ConfigError);

    expect(() => loadWorkerConfig({ ...minimal, MAX_TICKETS_PER_RUN: 'lots' })).toThrow(ConfigError);
  });

  it('should read the knobs it is given.', () => {
    const config = loadWorkerConfig({ ...minimal, MAX_TICKETS_PER_RUN: '3', POLL_INTERVAL_MS: '60000' });

    expect(config.maxTicketsPerRun).toBe(3);
    expect(config.pollIntervalMs).toBe(60000);
  });

  it('should refuse to start without a bot identity, since it could not tell its own claims apart.', () => {
    const { JIRA_BOT_ACCOUNT, ...noAccount } = minimal;
    const { JIRA_BOT_DISPLAY_NAME, ...noDisplayName } = minimal;

    expect(() => loadWorkerConfig(noAccount)).toThrow(ConfigError);
    expect(() => loadWorkerConfig(noDisplayName)).toThrow(ConfigError);
  });

  it('should default the spend ceilings to something a runaway can be discovered on cheaply.', () => {
    const config = loadWorkerConfig(minimal);

    expect(config.budget).toStrictEqual({ ticket: { maxTokens: 200_000, maxTurns: 40 }, maxTicketsPerDay: 5 });
  });

  it('should read the spend ceilings it is given, so a rollout can ramp them.', () => {
    const config = loadWorkerConfig({
      ...minimal,
      MAX_TOKENS_PER_TICKET: '50000',
      MAX_TURNS_PER_TICKET: '8',
      MAX_TICKETS_PER_DAY: '2',
    });

    expect(config.budget).toStrictEqual({ ticket: { maxTokens: 50_000, maxTurns: 8 }, maxTicketsPerDay: 2 });
  });

  it('should refuse a ceiling of zero rather than reading it as unlimited.', () => {
    // A metered API key has no ceiling of its own, so these are the only ones there are. One
    // that can be switched off with an env var is one that gets switched off during an
    // incident and stays off — there is deliberately no way to express "no limit".
    expect(() => loadWorkerConfig({ ...minimal, MAX_TOKENS_PER_TICKET: '0' })).toThrow(ConfigError);

    expect(() => loadWorkerConfig({ ...minimal, MAX_TURNS_PER_TICKET: '-1' })).toThrow(ConfigError);

    expect(() => loadWorkerConfig({ ...minimal, MAX_TICKETS_PER_DAY: 'none' })).toThrow(ConfigError);
  });

  it('should always fill the ceilings in, so nothing downstream has to cope with them missing.', () => {
    const config = loadWorkerConfig(minimal);

    expect(config.budget).toBeDefined();
    expect(budgetOf(config)).toStrictEqual(config.budget);
  });

  it('should read a config with no ceilings at all as the default ones, never as unlimited.', () => {
    const { budget, ...predatingTheCeilings } = loadWorkerConfig(minimal);

    // The field is optional on the type only, so that every hand-written WorkerConfig literal
    // in the suite kept compiling when the ceilings landed. The reading of an absent one has to
    // be the conservative default: a forgotten field must not be the cheapest way to switch the
    // worker's only cost ceiling off.
    expect(budgetOf(predatingTheCeilings)).toStrictEqual(DEFAULT_BUDGET);
    expect(budgetOf(predatingTheCeilings)).toStrictEqual(budget);
  });

  it('should keep the written identifier and the display name it reads back as separate.', () => {
    const config = loadWorkerConfig(minimal);

    // Two knobs, not one: a write takes an email or accountId, a read returns a
    // surname-first display name, and neither can be derived from the other.
    expect(config.bot).toStrictEqual({ account: 'developer-agent@mapcolonies.example', displayName: 'AGENT DEVELOPER' });
  });
});
