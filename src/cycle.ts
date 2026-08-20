import type { Logger } from '@map-colonies/js-logger';
import type { WorkerConfig } from '@common/workerConfig';
import { buildPollQuery } from './jira/query';
import type { JiraPort, JiraTicket } from './jira/types';
import { claimTicket, releaseTicket } from './tickets/claim';

/** The attempt cap from MAPCO-11432. Enforced in the query so a capped ticket is never even seen. */
const ATTEMPT_CAP = 2;

/**
 * What the worker says on a ticket it hands straight back.
 *
 * Written to be read by whoever finds the ticket back in Open and wonders what touched it.
 * It names what was tried, which in this slice is nothing at all.
 */
const HANDED_BACK_NOTE = [
  'Picked this up automatically and handed it straight back.',
  '',
  'This build of the developer agent can claim a ticket and release it, but there is nothing in between yet (MAPCO-11431) — no branch, no changes, no pull request. Nothing was modified, and this does not count as an attempt.',
  '',
  'The ticket is available again for whoever wants it next.',
].join('\n');

interface CycleDeps {
  readonly jira: JiraPort;
  readonly logger: Logger;
  readonly config: WorkerConfig;
}

interface CycleResult {
  readonly found: number;
  readonly started: number;
  readonly skipped: number;
  readonly more: boolean;
  readonly outcome: 'ok' | 'failed';
}

/**
 * Work through the run's tickets, no more than `maxConcurrentTickets` at a time.
 *
 * Both caps default to 1, which makes this sequential — the interesting case is a
 * deployment that raises them, where the concurrency cap is what keeps the worker from
 * claiming a whole page of tickets at once.
 */
async function handleTickets(tickets: JiraTicket[], deps: CycleDeps): Promise<number> {
  const { maxConcurrentTickets } = deps.config;
  let started = 0;

  for (let index = 0; index < tickets.length; index += maxConcurrentTickets) {
    const batch = tickets.slice(index, index + maxConcurrentTickets);
    const outcomes = await Promise.all(batch.map(async (ticket) => handleTicket(ticket, deps)));

    started += outcomes.filter((outcome) => outcome).length;
  }

  return started;
}

/**
 * Claim one ticket and hand it back. Returns whether the worker actually held it.
 *
 * Nothing in here is allowed to end the run: one ticket the worker cannot take says
 * nothing about the next one, and a run that dies on the first refusal would stall the
 * whole queue behind it.
 */
async function handleTicket(ticket: JiraTicket, deps: CycleDeps): Promise<boolean> {
  const { jira, logger, config } = deps;

  try {
    const claim = await claimTicket(ticket, jira, config.bot);

    if (!claim.ok) {
      // `saw` and `offered` are the diagnostic half of a refusal. A `lost-race` reporting
      // the bot's own name means JIRA_BOT_DISPLAY_NAME is wrong, not that a human raced;
      // `offered` names the transitions a workflow actually has.
      logger.warn({ msg: 'not claimed', key: ticket.key, reason: claim.reason, saw: claim.saw, offered: claim.offered });

      return false;
    }

    logger.info({ msg: 'claimed', key: ticket.key });

    const release = await releaseTicket(ticket, HANDED_BACK_NOTE, jira);

    if (!release.ok) {
      // Still assigned to the bot and still In Progress, on purpose — see `releaseTicket`.
      // The orphan sweep on boot (MAPCO-11432) is what gets it back.
      logger.error({ msg: 'held ticket could not be released', key: ticket.key, reason: release.reason, offered: release.offered });
    } else {
      logger.info({ msg: 'released', key: ticket.key });
    }

    return true;
  } catch (error) {
    logger.error({ msg: 'ticket failed', key: ticket.key, err: error });

    return false;
  }
}

/**
 * One full run of the worker, start to finish.
 *
 * This is the single seam the rest of the pipeline is built and tested through: the
 * scheduler calls it, and so do the tests. Later slices add cases here rather than
 * standing up harnesses of their own.
 *
 * In this slice it walks the whole Jira state machine with nothing in the middle: claim a
 * ticket, then release it again (MAPCO-11431).
 */
async function runCycle(deps: CycleDeps): Promise<CycleResult> {
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

  const started = await handleTickets(eligible, deps);

  const result: CycleResult = {
    found: eligible.length,
    started,
    skipped: eligible.length - started,
    more,
    outcome: 'ok',
  };

  // One structured line per run, shaped so Loki can ingest it later. A missing run line
  // is the alarm — there is no alerting stack by decision (MAPCO-11437).
  logger.info({
    msg: 'cycle complete',
    ...result,
    keys: eligible.map((ticket) => ticket.key),
    tokensSpent: 0,
  });

  return result;
}

export { ATTEMPT_CAP, HANDED_BACK_NOTE, runCycle };
export type { CycleDeps, CycleResult };
