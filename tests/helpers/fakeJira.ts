import type { JiraPort, JiraTicket, JiraTransition } from '@src/jira/types';

/** Every write the worker made, in order. Order is behaviour here, so tests assert on it. */
export type FakeWrite =
  | { kind: 'assign'; key: string; assignee: string | null }
  | { kind: 'transition'; key: string; transitionId: string }
  | { kind: 'comment'; key: string; body: string };

export interface FakeJiraOptions {
  tickets?: JiraTicket[];
  transitions?: Record<string, JiraTransition[]>;
  failWith?: Error;
  /**
   * What a written assignee identifier reads back as. Models the real asymmetry: the
   * worker writes an email or accountId, Jira reports a surname-first display name.
   */
  displayNames?: Record<string, string>;
  /** Makes the transition lookup fail, standing in for any mid-ticket Jira outage. */
  transitionsFailWith?: Error;
  /**
   * Simulates a human winning the race, applied the moment after the worker writes the
   * assignee — which is exactly the window the optimistic claim's re-read exists to catch.
   */
  stealOnAssign?: string;
}

/**
 * A double for the Jira side of the seam.
 *
 * It models exactly one piece of Jira's behaviour: an assignee write is visible to the next
 * read. That is not decoration — the optimistic claim's whole correctness rests on it. It
 * models nothing else, so a test can only ever assert on what the worker asked for.
 */
export class FakeJira implements JiraPort {
  public readonly queries: { jql: string; limit: number }[] = [];
  public readonly writes: FakeWrite[] = [];

  private readonly state = new Map<string, JiraTicket>();

  public constructor(private readonly options: FakeJiraOptions = {}) {
    for (const seed of options.tickets ?? []) {
      this.state.set(seed.key, seed);
    }
  }

  public async search(jql: string, limit: number): Promise<JiraTicket[]> {
    this.queries.push({ jql, limit });

    if (this.options.failWith) {
      throw this.options.failWith;
    }

    return Promise.resolve([...this.state.values()].slice(0, limit));
  }

  public async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    if (this.options.transitionsFailWith) {
      throw this.options.transitionsFailWith;
    }

    return Promise.resolve(this.options.transitions?.[issueKey] ?? []);
  }

  public async getIssue(issueKey: string): Promise<JiraTicket | null> {
    return Promise.resolve(this.state.get(issueKey) ?? null);
  }

  public async assign(issueKey: string, assignee: string | null): Promise<void> {
    this.writes.push({ kind: 'assign', key: issueKey, assignee });
    this.patch(issueKey, { assignee: this.readsBackAs(assignee) });

    return Promise.resolve();
  }

  public async transition(issueKey: string, transitionId: string): Promise<void> {
    this.writes.push({ kind: 'transition', key: issueKey, transitionId });

    // Deliberately does not move the ticket's status. Modelling that would invent a rule
    // Jira does not promise, and tests asserting on it would be checking this fake rather
    // than the worker — the recorded writes already say which transition was asked for.
    return Promise.resolve();
  }

  public async addComment(issueKey: string, body: string): Promise<void> {
    this.writes.push({ kind: 'comment', key: issueKey, body });

    return Promise.resolve();
  }

  private readsBackAs(assignee: string | null): string | null {
    if (assignee === null) {
      return null;
    }

    return this.options.stealOnAssign ?? this.options.displayNames?.[assignee] ?? assignee;
  }

  private patch(issueKey: string, changes: Partial<JiraTicket>): void {
    const current = this.state.get(issueKey);
    if (current) {
      this.state.set(issueKey, { ...current, ...changes });
    }
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
