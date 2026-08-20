export interface JiraTicket {
  readonly key: string;
  readonly summary: string;
  readonly issueType: string;
  readonly status: string;
  readonly labels: readonly string[];
  readonly assignee: string | null;
}

export interface JiraTransition {
  readonly id: string;
  readonly name: string;
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
}
