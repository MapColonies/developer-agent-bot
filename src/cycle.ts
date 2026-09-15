import type { Logger } from '@map-colonies/js-logger';
import type { WorkerConfig } from '@common/workerConfig';
import type { BudgetGuard, CycleGuard } from './budget/guard';
import type { DeliveryPort } from './deliver';
import { buildPollQuery } from './jira/query';
import type { JiraPort, JiraTicket } from './jira/types';
import { claimTicket } from './tickets/claim';
import type { HandBackOnce } from './tickets/handBackOnce';

/** The attempt cap from MAPCO-11432. Enforced in the query so a capped ticket is never even seen. */
const ATTEMPT_CAP = 2;

interface CycleDeps {
  readonly jira: JiraPort;
  readonly logger: Logger;
  readonly config: WorkerConfig;
  /**
   * What happens to a claimed ticket: clone, implement, verify, open a pull request.
   *
   * The one call this seam was missing. Everything around it — the poll, the claim, the
   * concurrency cap, the per-ticket containment — worked already and proved only itself.
   */
  readonly delivery: DeliveryPort;
  /**
   * The process's spend ceilings. One cycle is opened per run; see `runCycle`.
   *
   * Built once per process because the daily counter is a property of the day and the process is
   * what spans it. Passing it in rather than building it here is what makes that lifetime the
   * caller's to get right, and `src/worker.ts` is where it is got right.
   */
  readonly budget: BudgetGuard;
  /**
   * A fresh at-most-once hand-back. Called once per ticket, and never shared between two.
   *
   * The invariant it carries is that a ticket is handed back once however many give-up paths
   * fire on it — see `createHandBackOnce`.
   */
  readonly handBack: () => HandBackOnce;
}

interface CycleResult {
  readonly found: number;
  readonly started: number;
  readonly skipped: number;
  readonly more: boolean;
  readonly outcome: 'ok' | 'failed';
}

/**
 * What the worker says on a ticket it was holding when something unexpected went wrong.
 *
 * The alternative is worse than it sounds. `releaseTicket` and `handBackTicket` deliberately keep
 * hold of a ticket they cannot return to Open, on the argument that the boot-time orphan sweep
 * recovers it — but that sweep is MAPCO-11432 and does not exist yet, so a ticket dropped here is
 * a ticket assigned to a bot for ever, invisible to the poll and to whoever wrote it. Handing it
 * back costs an attempt and says so.
 */
function failedNote(error: unknown): string {
  return [
    'Picked this up automatically and stopped part-way through with an error.',
    '',
    '{code}',
    error instanceof Error ? error.message : String(error),
    '{code}',
    '',
    'This is the worker failing rather than the ticket being wrong, so it is worth a look. A branch under `agent/` may exist without a pull request; nothing was merged and nothing was approved. This counts as an attempt; the ticket is available again.',
  ].join('\n');
}

/**
 * Work through the run's tickets, no more than `maxConcurrentTickets` at a time.
 *
 * Both caps default to 1, which makes this sequential — the interesting case is a
 * deployment that raises them, where the concurrency cap is what keeps the worker from
 * claiming a whole page of tickets at once.
 */
async function handleTickets(tickets: JiraTicket[], deps: CycleDeps, cycle: CycleGuard): Promise<number> {
  const { maxConcurrentTickets } = deps.config;
  let started = 0;

  for (let index = 0; index < tickets.length; index += maxConcurrentTickets) {
    const batch = tickets.slice(index, index + maxConcurrentTickets);
    const outcomes = await Promise.all(batch.map(async (ticket) => handleTicket(ticket, deps, cycle)));

    started += outcomes.filter((outcome) => outcome).length;
  }

  return started;
}

/** Hand a held ticket back after an unexpected failure, without letting that fail the run too. */
async function releaseAfterFailure(ticket: JiraTicket, error: unknown, handBack: HandBackOnce, logger: Logger): Promise<void> {
  try {
    const released = await handBack.handBack(ticket, failedNote(error));

    if (!released.ok) {
      logger.error({ msg: 'failed ticket could not be handed back', key: ticket.key, reason: released.reason });
    }
  } catch (err) {
    // The second failure in a row. Nothing left to try, and a throw from in here would replace
    // the original error in the log with a complaint about Jira.
    logger.error({ msg: 'failed ticket could not be handed back', key: ticket.key, err });
  }
}

/**
 * Claim one ticket, work it, and make sure it does not stay held. Returns whether the worker
 * actually held it.
 *
 * Nothing in here is allowed to end the run: one ticket the worker cannot take says
 * nothing about the next one, and a run that dies on the first refusal would stall the
 * whole queue behind it.
 *
 * The claim goes through `cycle.start` rather than straight to `claimTicket`, and the indirection
 * is load-bearing: it is what checks the day still has room for a ticket *before* anything is
 * written, and what counts the ticket once the worker actually holds it. A run that has hit
 * `MAX_TICKETS_PER_DAY` writes nothing at all — a ticket claimed and then dropped for a spend
 * ceiling has already put a bot's name on a human's ticket and notified its watchers.
 */
async function handleTicket(ticket: JiraTicket, deps: CycleDeps, cycle: CycleGuard): Promise<boolean> {
  const { jira, logger, config, delivery } = deps;
  const handBack = deps.handBack();
  let held = false;

  try {
    const start = await cycle.start(ticket, async () => claimTicket(ticket, jira, config.bot));

    if (!start.ok) {
      if (start.reason === 'daily-cap') {
        // Already reported by the guard, at info: this is a ceiling doing its job, not a fault.
        return false;
      }

      // `saw` and `offered` are the diagnostic half of a refusal. A `lost-race` reporting
      // the bot's own name means JIRA_BOT_DISPLAY_NAME is wrong, not that a human raced;
      // `offered` names the transitions a workflow actually has.
      logger.warn({ msg: 'not claimed', key: ticket.key, reason: start.claim.reason, saw: start.claim.saw, offered: start.claim.offered });

      return false;
    }

    held = true;
    logger.info({ msg: 'claimed', key: ticket.key });

    const delivered = await delivery.deliver({ ticket, meter: start.ticket, handBack });

    if (delivered.ok) {
      logger.info({ msg: 'pull request opened for ticket', key: ticket.key, branch: delivered.branch, url: delivered.url });
    } else {
      // `handedBack: false` is the state worth finding in a log: the ticket is still assigned to
      // the bot and still In Progress, which the poll query skips, so nothing will pick it up.
      logger.warn({ msg: 'ticket not delivered', key: ticket.key, reason: delivered.reason, handedBack: delivered.handedBack });
    }

    return true;
  } catch (error) {
    logger.error({ msg: 'ticket failed', key: ticket.key, err: error });

    if (held) {
      await releaseAfterFailure(ticket, error, handBack, logger);
    }

    // Truthfully: the worker did hold this one, whatever happened next. The alternative reports a
    // ticket that was claimed, worked and commented on as one the run never touched.
    return held;
  }
}

/**
 * One full run of the worker, start to finish.
 *
 * This is the single seam the rest of the pipeline is built and tested through: the
 * scheduler calls it, and so do the tests. Later slices add cases here rather than
 * standing up harnesses of their own.
 *
 * A cycle is opened on the budget guard for each run, and that is not a formality. The daily
 * counter belongs to the process and has to survive every cycle, while the spend figure belongs
 * to the single "cycle complete" line it is reported on — holding both on one object was a real
 * bug, in which the spend never reset and a per-cycle field carried the process's lifetime total,
 * so any sum over those lines double-counted. `cycle.runLine()` is that cycle's own spend, which
 * is why it replaces the `tokensSpent: 0` this line used to carry.
 */
async function runCycle(deps: CycleDeps): Promise<CycleResult> {
  const { jira, logger, config } = deps;
  const jql = buildPollQuery(ATTEMPT_CAP);
  const cycle = deps.budget.cycle();

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

  const started = await handleTickets(eligible, deps, cycle);

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
    ...cycle.runLine(),
  });

  return result;
}

export { ATTEMPT_CAP, failedNote, runCycle };
export type { CycleDeps, CycleResult };
