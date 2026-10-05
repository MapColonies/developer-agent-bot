export interface JiraTicket {
  readonly key: string;
  readonly summary: string;
  readonly issueType: string;
  readonly status: string;
  readonly labels: readonly string[];
  readonly assignee: string | null;
  /**
   * The ticket's prose, when it was read.
   *
   * Optional because it is deliberately absent from the poll. Descriptions are long, the poll
   * asks for one more ticket than it will work (the server's `total` is always -1), and prose
   * the worker never uses is not worth carrying — so `POLL_FIELDS` does not ask for one and a
   * ticket off `search` never has one. It arrives on the per-ticket read instead, which is what
   * `DescriptionPort` (src/agent/types.ts) is for; see `ISSUE_FIELDS` in mcpJira.ts.
   *
   * Absent and empty are therefore different facts and must not be conflated: absent means
   * nobody asked, empty means the ticket has nothing on it. Only the second is a refusal.
   */
  readonly description?: string;
}

export interface JiraTransition {
  readonly id: string;
  /** The transition's own name — a verb on a real workflow, like `Start Progress`. */
  readonly name: string;
  /**
   * The status this transition lands the ticket in, when the server reports one.
   *
   * This is what the worker matches on. Asking for "the transition into In Progress" by
   * *name* only works on a workflow whose transitions happen to be named after their
   * target status, which is not the common case.
   */
  readonly to?: string;
}

/**
 * The Jira surface the worker uses. Everything the worker does to Jira goes through here
 * and is worker code, never model tooling — the Agent SDK is given file and test tools
 * only, so claiming, releasing and the attempt cap are not things the model can decline
 * to do (MAPCO-11436's principle, applied to Jira rather than git).
 */
export interface JiraPort {
  search: (jql: string, limit: number) => Promise<JiraTicket[]>;
  getTransitions: (issueKey: string) => Promise<JiraTransition[]>;
  /**
   * Read one issue back. This is the confirmation half of the optimistic claim: Jira is
   * the only state store, so the only way to know a claim held is to ask again.
   */
  getIssue: (issueKey: string) => Promise<JiraTicket | null>;
  /**
   * Write the assignee. `null` unassigns.
   *
   * Note the asymmetry with what reads return: a write takes an *identifier* (email or
   * accountId) while a read returns a *display name*, and in this instance display names
   * are surname-first, so the two cannot be assumed equal. That is why the worker is
   * configured with both (see `WorkerConfig.botAccount` / `botDisplayName`).
   */
  assign: (issueKey: string, assignee: string | null) => Promise<void>;
  transition: (issueKey: string, transitionId: string) => Promise<void>;
  addComment: (issueKey: string, body: string) => Promise<void>;
  /**
   * Replace a ticket's labels with exactly this set.
   *
   * A whole-set write rather than an add/remove pair because that is what the underlying tool
   * offers, and the caller has to have read the existing labels anyway to compute the next
   * counter. The consequence is worth stating: anything absent from `labels` is *removed*, so a
   * caller must pass the labels it wants kept, `agent-ready` included. `countAttempt`
   * (src/budget/attempt.ts) is the function that computes the set; do not derive it by hand.
   *
   * This is what carries the attempt counter, and the counter is the only thing that stops a
   * ticket the worker cannot finish from being picked up and paid for again on every tick.
   */
  setLabels: (issueKey: string, labels: readonly string[]) => Promise<void>;
}
