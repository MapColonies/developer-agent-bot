import type { JiraPort, JiraTicket, JiraTransition } from '@src/jira/types';

export interface FakeJiraOptions {
  tickets?: JiraTicket[];
  transitions?: Record<string, JiraTransition[]>;
  failWith?: Error;
}

/**
 * A double for the Jira side of the seam. Records the queries it was asked, so tests can
 * assert on what the worker *asked for* without asserting on how it phrased anything the
 * worker is free to change.
 */
export class FakeJira implements JiraPort {
  public readonly queries: { jql: string; limit: number }[] = [];

  public constructor(private readonly options: FakeJiraOptions = {}) {}

  public async search(jql: string, limit: number): Promise<JiraTicket[]> {
    this.queries.push({ jql, limit });

    if (this.options.failWith) {
      throw this.options.failWith;
    }

    return Promise.resolve((this.options.tickets ?? []).slice(0, limit));
  }

  public async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    return Promise.resolve(this.options.transitions?.[issueKey] ?? []);
  }
}

export function ticket(overrides: Partial<JiraTicket> = {}): JiraTicket {
  return {
    key: 'MAPCO-1',
    summary: 'some-service: do the thing',
    issueType: 'Task',
    status: 'Open',
    labels: ['agent-ready'],
    assignee: null,
    ...overrides,
  };
}
