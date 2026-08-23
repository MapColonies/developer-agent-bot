import type { BudgetCheck, OverrunKind, Spend, TicketBudget, TicketLedger } from './types';

/**
 * Meter one ticket against its budget (MAPCO-11435).
 *
 * The turn is charged *before* the verdict, which looks like an off-by-one and is not: a
 * metered API only tells you what a turn cost once it has already cost it, so nothing here
 * can refuse a turn in advance. The ceiling therefore means "no further turns once it is
 * used up", not "never crossed", and the ticket's comment reports the real total — including
 * the turn that went over — rather than a tidier number nobody was billed for.
 *
 * A ledger is per ticket. Reusing one across tickets would bill the second ticket for the
 * first one's work, which is exactly the property this slice exists to get right.
 *
 * The verdict latches: once a ledger has refused, it goes on refusing with the same reason and
 * says the refusal is not new. Only the first refusal can hand a ticket back, so a caller that
 * charges one more turn before it reacts cannot produce a second comment and a second release
 * on a ticket that is already in Open — an invariant in code rather than a rule in a comment.
 */
function createTicketLedger(budget: TicketBudget): TicketLedger {
  let tokens = 0;
  let turns = 0;
  /** The ceiling this ledger already refused on, if it has refused. Set once, never cleared. */
  let stopped: { readonly kind: OverrunKind; readonly limit: number } | null = null;

  const spend = (): Spend => ({ tokens, turns });

  return {
    charge: (spent: Spend): BudgetCheck => {
      // Charged even past the ceiling: the turns cost real money whether or not the ticket was
      // supposed to take them, and the totals in the comment and the run line have to be the
      // real ones. What does not repeat is the refusal being *new*.
      //
      // Both halves come from the caller. An earlier draft added `1` to the turn count per call,
      // which quietly redefined the ceiling as one-per-charge: a caller reporting a whole
      // hand-off's usage in one charge would have had forty hand-offs allowed by a
      // `MAX_TURNS_PER_TICKET` of 40, not forty turns.
      tokens += spent.tokens;
      turns += spent.turns;

      if (stopped !== null) {
        return { ok: false, kind: stopped.kind, limit: stopped.limit, spend: spend(), alreadyStopped: true };
      }

      // Both comparisons are `>=`, not `>`: a ticket that has spent exactly its allowance has
      // none left, and the next turn would put it over. `readInt` refuses a limit below 1, so a
      // ticket always gets to spend something before it can be stopped.
      //
      // Turns are checked first, which decides the tie when a single expensive turn uses up
      // both halves at once. That is deliberate: the turn count is the bound on *looping*, and
      // a loop wants a human to look at the agent rather than at the token knob.
      if (turns >= budget.maxTurns) {
        stopped = { kind: 'turns', limit: budget.maxTurns };

        return { ok: false, kind: 'turns', limit: budget.maxTurns, spend: spend(), alreadyStopped: false };
      }

      if (tokens >= budget.maxTokens) {
        stopped = { kind: 'tokens', limit: budget.maxTokens };

        return { ok: false, kind: 'tokens', limit: budget.maxTokens, spend: spend(), alreadyStopped: false };
      }

      return { ok: true, spend: spend() };
    },
    spend,
  };
}

export { createTicketLedger };
