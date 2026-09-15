import type { Logger } from '@map-colonies/js-logger';
import type { TicketGuard } from '../budget/guard';
import type { AttemptSummary, Spend } from '../budget/types';
import type { HandBackOnce } from '../tickets/handBackOnce';
import type { AgentOutcome, AgentPort, AgentRun, AgentRunRequest } from './types';

/** How much of a hand-off's summary goes into the attempt list on an aborted ticket's comment. */
const STEP_SUMMARY_LIMIT = 120;

/**
 * What one hand-off cost, in the units the ledger charges.
 *
 * `cacheRead` is **in** the token count, and that is the one judgement here worth arguing. The
 * SDK reports a prompt in two parts — the tokens it had to send and the tokens it read from
 * cache — and `Spend.tokens` is specified as "prompt and completion together, the invoice's
 * unit". A cache read is prompt: it is billed, at a discount, and an agentic loop re-reads its
 * whole context every turn, so a forty-turn run on a 100k context can read millions of them.
 * Leaving them out would mean most of what a ticket actually costs never reached the ceiling
 * that exists to bound it, and `MAX_TOKENS_PER_TICKET` would be a number about the small half
 * of the bill.
 *
 * `turns` comes off the run rather than being counted as one per hand-off, which is the mistake
 * `TicketLedger.charge` warns about by name: a hand-off that took twelve turns charges twelve,
 * because charging `1` would turn a ceiling of forty turns into forty hand-offs of forty turns.
 */
function spendOf(run: AgentRun): Spend {
  return { tokens: run.usage.input + run.usage.output + run.usage.cacheRead, turns: run.turns };
}

/** One line for the attempt list on an aborted ticket's comment. Says what the hand-off did. */
function describeStep(attempt: number, run: AgentRun): string {
  if (run.outcome === 'changed') {
    return `hand-off ${attempt}: changed files in the clone`;
  }

  if (run.outcome === 'no-change') {
    return `hand-off ${attempt}: read the ticket and changed nothing`;
  }

  return `hand-off ${attempt}: the run did not finish (${run.summary.slice(0, STEP_SUMMARY_LIMIT)})`;
}

interface MeteredAgentDeps {
  /** The real agent. Built once at boot, because that is where the model credential is read. */
  readonly agent: AgentPort;
  /** This ticket's meter, obtainable only from a `cycle.start` that claimed it. */
  readonly meter: TicketGuard;
  /**
   * This ticket's hand-back, told what the abort achieved.
   *
   * The seam that stops one ticket being handed back twice. `chargeSpend` performs the overspend
   * hand-back itself, through the `AbortPort` the guard was built with; `implementTicket` then
   * reports the stopped run as a give-up and hands the ticket back through `ReleasePort`. Passing
   * the abort's result to `record` is what makes the second one a no-op — see `HandBackOnce`.
   */
  readonly handBack: Pick<HandBackOnce, 'record'>;
  readonly logger: Logger;
}

/**
 * An `AgentPort` that charges every hand-off to the ticket's budget and stops when it runs out
 * (MAPCO-11435).
 *
 * Wrapping the agent is what makes the per-ticket ceiling bite *during* a ticket. The obvious
 * alternative — charge once after `implementTicket` returns — cannot: by then the ticket has
 * either been handed back already or has a verified change waiting to be published, so the
 * ceiling could only ever be enforced in hindsight, and one ticket could spend ten times it
 * before anything noticed. Charging per hand-off puts the check at the same granularity
 * `implementTicket` already works at, and each hand-off is itself bounded by `maxTurns`.
 *
 * The hand-back on overspend is not performed here. `chargeSpend` calls `AbortPort.abort` on the
 * charge that first runs the budget out, and that port is bound to `handBackTicket` — so the
 * comment, the attempt count and the release have already happened by the time the charge
 * returns. What this does with that fact is three things: tell the ticket's latch through
 * `record`, so the give-up that follows writes nothing; refuse to spend anything more; and
 * report the run as over, which takes `implementTicket` to its single give-up exit. One ticket,
 * one comment, one attempt counted.
 *
 * A run that *throws* is left to throw: `runAgent` in implement.ts contains it, and a transport
 * failure with no usage attached has nothing to charge.
 */
function meterAgent(deps: MeteredAgentDeps): AgentPort {
  const { agent, meter, handBack, logger } = deps;
  const tried: string[] = [];
  let changedAnything = false;
  let stopped: string | null = null;

  const attemptSummary = (): AttemptSummary => ({
    tried: [...tried],
    reached: changedAnything ? 'a change in the clone, not yet verified' : null,
  });

  const over = (summary: string): AgentRun => ({
    outcome: 'gave-up' satisfies AgentOutcome,
    usage: { input: 0, output: 0, cacheRead: 0, costUsd: 0 },
    turns: 0,
    summary,
    deniedTools: [],
  });

  return {
    run: async (request: AgentRunRequest): Promise<AgentRun> => {
      if (stopped !== null) {
        // Not reached by `implementTicket`, which breaks out of its loop on a give-up — but a
        // port that would happily spend again after being told to stop is not one to rely on.
        logger.warn({ msg: 'refusing a hand-off after the ticket ran out of budget', key: request.task.key });

        return over(stopped);
      }

      const run = await agent.run(request);

      tried.push(describeStep(tried.length + 1, run));
      changedAnything = changedAnything || run.outcome === 'changed';

      const charged = await meter.charge(spendOf(run), attemptSummary());

      if (charged.ok) {
        return run;
      }

      if (!charged.alreadyStopped) {
        // What `chargeSpend` just did to the ticket, handed to the latch so the give-up that
        // follows does not do it again. `alreadyStopped` means an earlier charge did the writing,
        // and the latch was told then.
        handBack.record({ released: charged.released, attemptCounted: charged.attemptCounted });
      }

      const { kind, limit, spend } = charged.overspend;
      stopped = `the per-ticket budget ran out: ${spend.turns} turns and ${spend.tokens} tokens against a ceiling of ${limit} ${kind}`;

      // The ticket is already commented, counted and released by `AbortPort.abort` — this line
      // is what ties the spend to the hand-off that spent it, next to what that hand-off did.
      logger.warn({ msg: 'stopping the ticket for budget', key: request.task.key, kind, limit, outcome: run.outcome, ...spend });

      // Reported as over even when this hand-off changed files: the change is unverified — the
      // suite has not run — and publishing it would spend past the ceiling to do it.
      return over(stopped);
    },
  };
}

export { meterAgent, spendOf };
export type { MeteredAgentDeps };
