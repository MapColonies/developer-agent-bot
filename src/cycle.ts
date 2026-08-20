import type { Logger } from '@map-colonies/js-logger';
import type { WorkerConfig } from '@common/workerConfig';
import { buildPollQuery } from './jira/query';
import type { JiraPort, JiraTicket } from './jira/types';

/** The attempt cap from MAPCO-11432. Enforced in the query so a capped ticket is never even seen. */
export const ATTEMPT_CAP = 2;

export interface CycleDeps {
  readonly jira: JiraPort;
  readonly logger: Logger;
  readonly config: WorkerConfig;
}

export interface CycleResult {
  readonly found: number;
  readonly started: number;
  readonly skipped: number;
  readonly more: boolean;
  readonly outcome: 'ok' | 'failed';
}

/**
 * One full run of the worker, start to finish.
 *
 * This is the single seam the rest of the pipeline is built and tested through: the
 * scheduler calls it, and so do the tests. Later slices add cases here rather than
 * standing up harnesses of their own.
 *
 * In this slice it polls and reports. It starts nothing and writes nothing to Jira.
 */
export async function runCycle(deps: CycleDeps): Promise<CycleResult> {
  const { jira, logger, config } = deps;
  const jql = buildPollQuery(ATTEMPT_CAP);

  let tickets: JiraTicket[];
  try {
    // One over the limit, so a full page is distinguishable from an exhausted queue.
    tickets = await jira.search(jql, config.maxTicketsPerRun + 1);
  } catch (error) {
    const result: CycleResult = { found: 0, started: 0, skipped: 0, more: false, outcome: 'failed' };
    logger.error({ msg: 'poll failed', err: error, ...result });

    return result;
  }

  const more = tickets.length > config.maxTicketsPerRun;
  const eligible = tickets.slice(0, config.maxTicketsPerRun);

  const result: CycleResult = {
    found: eligible.length,
    started: 0,
    skipped: eligible.length,
    more,
    outcome: 'ok',
  };

  // One structured line per run, shaped so Loki can ingest it later. A missing run line
  // is the alarm — there is no alerting stack by decision (MAPCO-11437).
  logger.info({
    msg: 'poll complete',
    ...result,
    reason: 'read-only slice: this worker cannot claim yet',
    keys: eligible.map((ticket) => ticket.key),
    tokensSpent: 0,
  });

  return result;
}
