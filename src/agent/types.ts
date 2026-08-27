import type { JiraTicket } from '../jira/types';

/**
 * The ticket, in the words a human wrote on it. This is the whole of what the model is told
 * to do — there is no separate machine-readable instruction, on purpose: a ticket a person
 * cannot act on is not one the model should be guessing at either.
 *
 * `description` is a separate field rather than part of `JiraTicket` because the poll does not
 * fetch one — it is read per claimed ticket, through `DescriptionPort`.
 */
interface AgentTask {
  readonly key: string;
  readonly summary: string;
  readonly description: string;
}

/**
 * What one run cost. Reported per run rather than accumulated inside the port so the caller
 * can add up attempts and log one number, which is what the cycle line wants (MAPCO-11437).
 */
interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** The SDK's own cost estimate, in USD. An estimate, not a billing statement. */
  readonly costUsd: number;
}

/**
 * What a run did, in terms an outside observer can check.
 *
 * `changed` means the model wrote at least one file — not that the change is any good, which
 * is what the test run is for. `no-change` is a real outcome and not a failure to report: a
 * model that read the repo and wrote nothing has nothing to verify, and retrying it with the
 * same input would produce the same nothing. `gave-up` is the run itself ending badly — the
 * turn budget ran out, the API errored — as opposed to the change being wrong.
 */
type AgentOutcome = 'changed' | 'no-change' | 'gave-up';

interface AgentRunRequest {
  readonly task: AgentTask;
  /** The clone the model works in. Nothing outside it is in scope. */
  readonly workdir: string;
  /**
   * Turn budget for this one run. This is not the attempt bound — the attempt bound belongs
   * to the caller and is how many times the model is handed the ticket at all. This is how
   * far the model may go inside a single hand-off before it is cut off.
   */
  readonly maxTurns: number;
  /** How the previous attempt's test run failed, when this run is a retry. Verbatim output. */
  readonly previousFailure?: string;
}

interface AgentRun {
  readonly outcome: AgentOutcome;
  readonly usage: TokenUsage;
  /** What the model said it did, or why it stopped. Goes in the log and the give-up comment. */
  readonly summary: string;
  /**
   * Tools the permission layer refused mid-run, by name.
   *
   * Kept because it is the only in-band evidence that the restriction did its job. A run
   * that reports `Bash` here means the model went looking for a shell — the change is still
   * safe, but the prompt is misleading it and that is worth seeing in the pod logs.
   */
  readonly deniedTools: readonly string[];
}

/**
 * One run of the model against one ticket.
 *
 * Deliberately one call and no session handle: a retry is a fresh run with the test failure
 * in its prompt, not a conversation that stays open. That keeps the orchestration testable
 * without the SDK and means a crash between attempts loses nothing but tokens.
 */
interface AgentPort {
  run: (request: AgentRunRequest) => Promise<AgentRun>;
}

/** The two bounds on one ticket's worth of work. Both exist to stop an unbounded spend. */
interface AgentLimits {
  /** How many times the model may be handed the ticket before the run gives up. */
  readonly maxAttempts: number;
  /** Turn budget for each of those hand-offs. */
  readonly maxTurns: number;
}

/**
 * A claimed ticket and the clone to work it in — everything the implement step needs and
 * nothing about how either was obtained.
 *
 * The ticket arrives already claimed (MAPCO-11431) and the clone already made and classified
 * (MAPCO-11433). Neither is this module's business, which is why they come in as values.
 */
interface Assignment {
  readonly ticket: JiraTicket;
  readonly workdir: string;
}

/**
 * The ticket's prose, read one claimed ticket at a time.
 *
 * A port rather than a field on `Assignment` because there is nothing to pass yet and a field
 * would have hidden that: `JiraTicket` (src/jira/types.ts) carries no description, the poll's
 * `fields` list does not ask for one, and `JiraPort` has no call that returns one — so the only
 * value a caller could have supplied was `''`, on every ticket, for ever. As an interface it is
 * a thing someone has to implement instead of a default someone can accept by accident.
 *
 * Implementing it is three lines in files this slice does not own (MAPCO-11431's): a
 * `description` field on `JiraTicket`, `description` in `POLL_FIELDS`, and one mapping line in
 * `toTicket` (src/jira/mcpJira.ts) — the MCP server's `jira_get_issue` already returns it. Until
 * then the honest implementation is one that returns `''`, and `implementTicket` answers that by
 * handing the ticket back **before** the first model turn rather than paying for a hand-off it
 * knows the answer to.
 *
 * Read per ticket rather than at poll time on purpose: descriptions are long, the poll asks for
 * one more ticket than it will work, and prose the worker never uses is not worth carrying.
 */
interface DescriptionPort {
  read: (ticket: JiraTicket) => Promise<string>;
}

/**
 * Whether a release held. Structurally the same as `ReleaseOutcome` in src/tickets/claim.ts,
 * restated here rather than imported so this slice does not pin down a type that MAPCO-11431
 * is actively reshaping — `ReleaseOutcome` is assignable to it either way.
 */
type ReleaseResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * The give-up path, as narrowly as this slice needs it.
 *
 * Named `handBack` rather than `release` deliberately, because it is **not** `releaseTicket`.
 * A hand-back is four things: count that the worker has now tried this ticket, then comment,
 * transition to Open and unassign. `releaseTicket` (src/tickets/claim.ts) does the last three
 * and deliberately does not count — it is also the release used by paths that must not, like the
 * hand-straight-back in `runCycle`, which does no work and spends nothing.
 *
 * The count is what ends a loop: it lives in a Jira label (`LABELS.attemptedPrefix`,
 * src/common/constants.ts) and is what `ATTEMPT_CAP` filters the poll on, so without it a ticket
 * the model cannot fix is picked up again on every tick, for ever, at full token price. It
 * belongs *behind this one call* rather than beside it, so that no path can release a ticket
 * without counting it.
 *
 * A binding that only calls `releaseTicket` therefore satisfies the type and not the contract.
 * Bind to `handBackTicket` (src/tickets/handBack.ts), which does both in the order that is safe
 * if it fails part-way.
 */
interface ReleasePort {
  handBack: (ticket: JiraTicket, note: string) => Promise<ReleaseResult>;
}

export type {
  AgentLimits,
  AgentOutcome,
  AgentPort,
  AgentRun,
  AgentRunRequest,
  AgentTask,
  Assignment,
  DescriptionPort,
  ReleasePort,
  ReleaseResult,
  TokenUsage,
};
