/**
 * The vocabulary of the worker's own cost ceiling (MAPCO-11435).
 *
 * A metered API key has no ceiling of its own, so the worker carries one. Two halves, because
 * they bound different things: a per-ticket token/turn budget bounds how deep a single ticket
 * may go, and a per-day counter bounds how many tickets get started at all. Both are config,
 * so the rollout can start slow and ramp as quality is proven.
 *
 * Going over is an outcome, not an exception in a log. The ticket is aborted, commented with
 * what it spent and how far it got, and handed back through `AbortPort` — so the cost lands on
 * the ticket that caused it and overspend shows up in Jira rather than only on an invoice.
 * Whether the hand-back also managed to count the attempt is reported, not assumed: see
 * `AbortResult`.
 */

import type { JiraTicket } from '../jira/types';

/**
 * An amount of spending: either a running total for a ticket, or one increment charged to it.
 *
 * Both halves are counted in the units they are billed in. `turns` means *model* turns — one
 * request and its response — and never a coarser unit like "one hand-off to the agent". A
 * caller with a hand-off that took twelve turns charges twelve; charging one would make a
 * `MAX_TURNS_PER_TICKET` of 40 mean forty hand-offs of up to forty turns each, which is a
 * ceiling forty times higher than the one an operator set. See `TicketLedger.charge`.
 */
interface Spend {
  /** Tokens billed to this ticket, prompt and completion together — the invoice's unit. */
  readonly tokens: number;
  /** Model turns spent on this ticket. One turn is one request and its response. */
  readonly turns: number;
}

/**
 * The ceiling for one ticket.
 *
 * Both halves are needed, and neither implies the other: a stuck agent can burn forty turns
 * on trivially cheap calls (a tool that keeps erroring), and a single turn on a huge context
 * can cost more than forty small ones.
 */
interface TicketBudget {
  readonly maxTokens: number;
  readonly maxTurns: number;
}

/** Every spend ceiling the worker has, as configured. Reached as `WorkerConfig.budget`. */
interface BudgetConfig {
  /** The ceiling applied to each ticket the worker works. */
  readonly ticket: TicketBudget;
  /**
   * How many tickets the worker may start in a day. Bounds volume where `ticket` bounds
   * depth. Counted in memory, which makes it per process-day — see `createDailyCap`.
   */
  readonly maxTicketsPerDay: number;
}

/** Which half of the per-ticket budget ran out. Reported so a reader knows which knob to turn. */
type OverrunKind = 'tokens' | 'turns';

interface BudgetExhausted {
  readonly ok: false;
  readonly kind: OverrunKind;
  /** The limit that was reached, in the unit named by `kind`. */
  readonly limit: number;
  /** What the ticket had cost by the time it stopped, including the turn that went over. */
  readonly spend: Spend;
  /**
   * False exactly once per ledger: on the charge that first ran the budget out. True on every
   * charge after it.
   *
   * The distinction is what stops a ticket being handed back twice. A caller that keeps
   * charging — because a turn was already in flight when the last one refused, or because it
   * read a failed hand-back as retryable — would otherwise trip the whole abort path again and
   * leave a second "budget exhausted" comment on a ticket already back in Open, possibly one a
   * human has since picked up. The ledger latches so that cannot happen, rather than a comment
   * asking callers not to do it.
   */
  readonly alreadyStopped: boolean;
}

/** Whether a ticket may keep going, and what it has cost either way. */
type BudgetCheck = { readonly ok: true; readonly spend: Spend } | BudgetExhausted;

/**
 * What the ticket got for the money.
 *
 * Supplied by whatever was doing the work; the budget module never invents it, because only
 * the caller knows how far it got. It exists so the comment on an aborted ticket says
 * something a human can act on instead of only a number.
 */
interface AttemptSummary {
  /** What was tried, in order, one short line each. Empty means it never got going. */
  readonly tried: readonly string[];
  /** How far it got, in a phrase — `branch pushed, no pull request`. Null when nowhere. */
  readonly reached: string | null;
}

/** The whole story of a ticket that ran out of budget: what broke, what it cost, what it managed. */
interface Overspend {
  readonly kind: OverrunKind;
  readonly limit: number;
  readonly spend: Spend;
  readonly attempt: AttemptSummary;
}

/**
 * The meter for one ticket. Not reusable: a ledger belongs to the ticket it was created for,
 * and a fresh one per ticket is what makes "cost lands on the ticket that caused it" true.
 */
interface TicketLedger {
  /**
   * Charge some spending to the ticket and say whether it may spend any more.
   *
   * Takes both halves rather than counting a turn per call, and that is the whole reason this
   * takes a `Spend` instead of a token count. A caller reporting usage once per hand-off — which
   * is what `AgentPort.run` gives you today — would then have had its *hand-offs* counted against
   * a ceiling named in turns, and a `MAX_TURNS_PER_TICKET` of 40 would have permitted forty
   * hand-offs of forty turns apiece. Making the turn count an argument means a caller that does
   * not know it has to decide what to say rather than have the ledger quietly say `1`.
   *
   * Keeps charging after the budget is gone — the money was spent either way, and the totals
   * have to be the real ones — but reports every charge past the ceiling as `alreadyStopped`,
   * so only the first one can trigger a hand-back.
   */
  charge: (spent: Spend) => BudgetCheck;
  /** What the ticket has cost so far. Keeps answering after the budget is gone. */
  spend: () => Spend;
}

/** The daily counter as it stands, shaped for the run line. */
interface DailyCapState {
  /** Tickets started in the current window. */
  readonly startedToday: number;
  readonly limit: number;
  /** Whether the cap is reached, so a run can say why it started nothing. */
  readonly exhausted: boolean;
}

/**
 * The per-day started-ticket counter.
 *
 * Asking and counting are separate calls on purpose — see `createDailyCap` for why a ticket
 * is counted only once the worker actually holds it.
 */
interface DailyCap {
  /** Count a ticket the worker actually got hold of. */
  recordStart: () => void;
  /**
   * The counter as it stands, which is also how a caller asks whether it may start: a run
   * reads `exhausted` and reports the numbers next to it, and one call answers both. Rolls
   * the window forward if the day has changed since the last question.
   */
  state: () => DailyCapState;
}

/**
 * Where the budget module gets the time from.
 *
 * Injected rather than reading the clock inline so a test can walk a process across a day
 * boundary without waiting for one, and so no module-load-time `Date.now()` decides what
 * "today" means for the lifetime of the process.
 */
type Clock = () => number;

/**
 * What the hand-back actually managed.
 *
 * Two separate booleans because they fail separately and one of them cannot currently succeed
 * at all. Reported rather than assumed: the alternative is a comment on the ticket claiming
 * something happened that did not, which is worse than no claim.
 */
interface AbortResult {
  /**
   * True when the ticket is back in Open and unassigned, so another run or a human can pick it
   * up. False means the worker still holds it, In Progress — the containment `releaseTicket`
   * chooses on a stuck workflow, recovered by the boot-time orphan sweep (MAPCO-11432).
   */
  readonly released: boolean;
  /**
   * True when the attempt was counted, i.e. the ticket's `agent-attempted-N` label was bumped.
   *
   * Which labels that means is not left to the implementer to work out: `countAttempt` in
   * `budget/attempt.ts` computes the exact label set, so the policy lives in this slice and
   * every implementation of the port counts the same way. The write itself is
   * `JiraPort.setLabels`, and `handBackTicket` (src/tickets/handBack.ts) is the binding that puts
   * the two together — bind to that rather than writing a second one.
   *
   * `false` is still reachable, and deliberately so: the label write can fail. When it does the
   * hand-back stops rather than releasing an uncounted ticket, so `released` comes back `false`
   * with it.
   *
   * `false` matters because it is the runaway this slice exists to bound. An uncounted overspend
   * still matches the poll query — `buildPollQuery` filters on `agent-ready`, an empty assignee
   * and the label *at* `ATTEMPT_CAP` — so the next cycle picks the same ticket up and spends the
   * same budget on it again, one ticket able to eat the whole daily allowance. `chargeSpend`
   * logs that loudly rather than letting it pass, and the comment on the ticket never claims a
   * count that did not happen.
   */
  readonly attemptCounted: boolean;
}

/**
 * How the budget module gives an overspent ticket back.
 *
 * Deliberately a ticket and a note rather than a Jira client: the release path itself —
 * comment, transition to Open, unassign last, bump the attempt label — is MAPCO-11431 and
 * MAPCO-11432's to implement, and this slice must not grow a second implementation of it.
 * The budget module's job ends at deciding to stop, saying what it cost, and reporting how
 * much of the hand-back succeeded.
 */
interface AbortPort {
  /**
   * Comment `note` on the ticket, hand the ticket back, and count the attempt against it.
   *
   * An overspend should count as an attempt — unlike the hand-straight-back note in `runCycle`,
   * which explicitly does not, because that one does no work and spends nothing. The labels to
   * write are `countAttempt(ticket.labels)`; use it rather than deriving them, so an overspend
   * counts the same way an implementation refusal does.
   *
   * The hand-back's own order is not this module's to choose either: `releaseTicket` comments,
   * transitions to Open and unassigns *last*, because unassigning is what puts the ticket back
   * in front of the poll query. An implementation must go through it rather than reproduce it.
   *
   * An implementation that cannot count the attempt must say so in its `AbortResult` rather than
   * quietly skipping it; throwing is for a hand-back that achieved nothing at all.
   */
  abort: (ticket: JiraTicket, note: string) => Promise<AbortResult>;
}

export type {
  AbortPort,
  AbortResult,
  AttemptSummary,
  BudgetCheck,
  BudgetConfig,
  BudgetExhausted,
  Clock,
  DailyCap,
  DailyCapState,
  Overspend,
  OverrunKind,
  Spend,
  TicketBudget,
  TicketLedger,
};
