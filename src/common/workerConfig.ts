/**
 * Worker knobs.
 *
 * Deliberately env-based rather than `@map-colonies/config`. That library resolves a
 * schema published in `@map-colonies/schemas`, and no schema exists for this service yet;
 * the telemetry half still goes through it (see `common/config.ts`) because
 * `commonBoilerplateV3` already covers logger and tracing. Registering a real schema for
 * these knobs is follow-up work, not a blocker for the current slice.
 */

import type { BotIdentity } from '../tickets/claim';

interface WorkerConfig {
  /** How often the internal scheduler runs a cycle. */
  readonly pollIntervalMs: number;
  /** How many tickets one cycle may start. Defaults to 1 per MAPCO-11429. */
  readonly maxTicketsPerRun: number;
  /** How many tickets may be in flight at once. Defaults to 1 per MAPCO-11429. */
  readonly maxConcurrentTickets: number;
  /** Base URL of the in-cluster `atlassian-write` MCP server. */
  readonly mcpUrl: string;
  /** Who the worker claims tickets as. Both halves are required — see `BotIdentity`. */
  readonly bot: BotIdentity;
}

const DEFAULT_POLL_INTERVAL_MS = 300_000;

class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }

  return parsed;
}

function readRequired(env: NodeJS.ProcessEnv, name: string, why: string): string {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    throw new ConfigError(`${name} must be set — ${why}`);
  }

  return raw;
}

function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const mcpUrl = readRequired(env, 'MCP_ATLASSIAN_URL', 'the worker has no Jira credentials of its own');
  const bot: BotIdentity = {
    account: readRequired(env, 'JIRA_BOT_ACCOUNT', 'the worker has no way to put its own name on a ticket'),
    displayName: readRequired(env, 'JIRA_BOT_DISPLAY_NAME', "the worker could not tell its own claims from a human's"),
  };

  return {
    pollIntervalMs: readInt(env, 'POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    maxTicketsPerRun: readInt(env, 'MAX_TICKETS_PER_RUN', 1),
    maxConcurrentTickets: readInt(env, 'MAX_CONCURRENT_TICKETS', 1),
    mcpUrl,
    bot,
  };
}

export { ConfigError, loadWorkerConfig };
export type { WorkerConfig };
