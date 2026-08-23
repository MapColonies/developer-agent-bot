import type { DailyCapState, Overspend, OverrunKind, Spend } from './types';

/**
 * Numbers in a Jira comment are formatted with an explicit locale, never the ambient one: a
 * pod's locale is not a thing anyone chooses, and the same overspend must not read as
 * `212,431` on one worker and `212.431` on the next.
 */
const COUNT = new Intl.NumberFormat('en-GB');

/** The unit a limit is expressed in, for the sentence that names it. */
const UNITS: Record<OverrunKind, string> = { tokens: 'tokens', turns: 'turns' };

/**
 * What the worker says on a ticket it stopped for money (MAPCO-11435).
 *
 * Written for whoever finds the ticket back in Open: what it cost, which ceiling it hit, what
 * it managed first, and which knob to turn. The spend is in the comment because the comment is
 * where the cost becomes visible — the ticket that caused the spend is the only place the
 * spend is attributable to, since there is no dashboard and no alerting stack (MAPCO-11437).
 */
function describeOverspend(overspend: Overspend): string {
  const { kind, limit, spend, attempt } = overspend;

  const lines = [
    'Stopped this ticket: it ran out of the budget I am allowed to spend on one ticket.',
    '',
    `Spent ${COUNT.format(spend.turns)} turns and ${COUNT.format(spend.tokens)} tokens. The ceiling I hit was ${COUNT.format(limit)} ${UNITS[kind]} per ticket.`,
    '',
  ];

  if (attempt.tried.length > 0) {
    lines.push('What I tried, in order:', ...attempt.tried.map((step) => `- ${step}`), '');
  } else {
    lines.push('I never got as far as trying anything, which is itself worth a look — the budget went on getting started.', '');
  }

  if (attempt.reached !== null) {
    lines.push(`How far it got: ${attempt.reached}.`, '');
  }

  // Says only what this module knows to be true, and the attempt count is deliberately not in
  // it — for a reason of ordering rather than of policy. This note is an *argument* to
  // `AbortPort.abort`: it is composed before the hand-back is attempted, so at the moment these
  // words are written nothing yet knows whether the count, the transition or the unassign
  // succeeded. Any sentence here about the attempt would be a prediction, and the prediction
  // that matters is the one that goes wrong — a comment claiming the attempt was counted tells
  // whoever reads it the ticket is safe from being picked up and re-burnt, exactly when it is
  // not (`JiraPort` has no label write; see `countAttempt` and `AbortResult.attemptCounted`).
  // What actually happened is reported in the log, where it can be written afterwards. (The
  // write exists now — `JiraPort.setLabels`, applied by `handBackTicket` — but the ordering
  // argument is unchanged: this note is composed before any of it is attempted.)
  lines.push(
    `Handing the ticket back. Raise \`${kind === 'turns' ? 'MAX_TURNS_PER_TICKET' : 'MAX_TOKENS_PER_TICKET'}\` if this ticket genuinely needs more room than that; if it should have been plenty, the list above is where the money went.`
  );

  return lines.join('\n');
}

/**
 * The budget half of the one structured "cycle complete" line (MAPCO-11437 keeps that line the
 * only alarm there is, so what a run spent has to be in it).
 *
 * `tokensSpent` keeps the name the run line already carries as a hard-coded zero, so wiring
 * this in is a substitution rather than a rename of a field someone may already be querying.
 */
interface BudgetRunLine {
  readonly tokensSpent: number;
  readonly turnsSpent: number;
  readonly ticketsStartedToday: number;
  readonly dailyCapLimit: number;
  /** True on a run that polled and deliberately started nothing. */
  readonly dailyCapReached: boolean;
}

function budgetRunLine(spend: Spend, cap: DailyCapState): BudgetRunLine {
  return {
    tokensSpent: spend.tokens,
    turnsSpent: spend.turns,
    ticketsStartedToday: cap.startedToday,
    dailyCapLimit: cap.limit,
    dailyCapReached: cap.exhausted,
  };
}

export { budgetRunLine, describeOverspend };
export type { BudgetRunLine };
