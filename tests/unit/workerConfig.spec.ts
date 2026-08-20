/* eslint-disable @typescript-eslint/naming-convention -- these are environment variable names */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadWorkerConfig } from '@src/common/workerConfig';

const minimal = { MCP_ATLASSIAN_URL: 'http://mcp-atlassian:8080/mcp' };

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
});
