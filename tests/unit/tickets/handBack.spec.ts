import { describe, expect, it } from 'vitest';
import { handBackTicket } from '@src/tickets/handBack';
import { FakeJira, ticket } from '@tests/helpers/fakeJira';
import { fakeLogger } from '@tests/helpers/fakeLogger';
import type { FakeWrite } from '@tests/helpers/fakeJira';

const ATTEMPT_CAP = 2;
const NOTE = 'Ran out of budget on this one.';

const workflow = {
  'MAPCO-1': [
    { id: '21', name: 'Start Progress', to: 'In Progress' },
    { id: '11', name: 'Reopen', to: 'Open' },
  ],
};

function kinds(writes: readonly FakeWrite[]): string[] {
  return writes.map((write) => write.kind);
}

describe('handBackTicket', () => {
  it('should count the attempt and give the ticket back.', async () => {
    const { logger } = fakeLogger();
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflow });

    const outcome = await handBackTicket(ticket(), NOTE, { jira, logger, attemptCap: ATTEMPT_CAP });

    expect(outcome).toStrictEqual({ released: true, attemptCounted: true });
    expect(jira.writes).toContainEqual({ kind: 'labels', key: 'MAPCO-1', labels: ['agent-ready', 'agent-attempted-1'] });
    expect(jira.writes).toContainEqual({ kind: 'assign', key: 'MAPCO-1', assignee: null });
  });

  it('should write the counter before unassigning, because unassigning is what makes it pollable.', async () => {
    const { logger } = fakeLogger();
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflow });

    await handBackTicket(ticket(), NOTE, { jira, logger, attemptCap: ATTEMPT_CAP });

    // Order is the whole correctness argument: an unassigned ticket matches the poll query, so a
    // counter written after the unassign leaves a window where the ticket is available and
    // uncounted — and if that write then fails, the window never closes.
    expect(kinds(jira.writes)).toStrictEqual(['labels', 'comment', 'transition', 'assign']);
  });

  it('should keep holding the ticket when the counter cannot be written.', async () => {
    const { logger, lines } = fakeLogger();
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflow, setLabelsFailWith: new Error('jira said no') });

    const outcome = await handBackTicket(ticket(), NOTE, { jira, logger, attemptCap: ATTEMPT_CAP });

    // Held-and-uncounted is recovered by the boot-time orphan sweep. Released-and-uncounted is a
    // ticket that polls straight back in and is paid for again, for ever.
    expect(outcome).toMatchObject({ released: false, attemptCounted: false, reason: 'attempt-count-failed' });
    expect(jira.writes).toStrictEqual([]);
    expect(lines.filter((line) => line.level === 'error')).toHaveLength(1);
  });

  it('should bump an existing counter rather than adding a second one.', async () => {
    const { logger } = fakeLogger();
    const held = ticket({ labels: ['agent-ready', 'agent-attempted-1', 'needs-discussion'] });
    const jira = new FakeJira({ tickets: [held], transitions: workflow });

    await handBackTicket(held, NOTE, { jira, logger, attemptCap: ATTEMPT_CAP });

    expect(jira.writes[0]).toStrictEqual({
      kind: 'labels',
      key: 'MAPCO-1',
      labels: ['agent-ready', 'needs-discussion', 'agent-attempted-2'],
    });
  });

  it('should never write a counter past the cap, which would make the ticket pollable again.', async () => {
    const { logger } = fakeLogger();
    const capped = ticket({ labels: ['agent-ready', 'agent-attempted-2'] });
    const jira = new FakeJira({ tickets: [capped], transitions: workflow });

    await handBackTicket(capped, NOTE, { jira, logger, attemptCap: ATTEMPT_CAP });

    // The poll excludes the label *exactly* at the cap, so `agent-attempted-3` would not tighten
    // anything — it would hand the ticket straight back to the worker.
    expect(jira.writes[0]).toStrictEqual({ kind: 'labels', key: 'MAPCO-1', labels: ['agent-ready', 'agent-attempted-2'] });
  });

  it('should report the attempt as counted even when the release cannot finish.', async () => {
    const { logger } = fakeLogger();
    const stuck = { 'MAPCO-1': [{ id: '21', name: 'Start Progress', to: 'In Progress' }] };
    const jira = new FakeJira({ tickets: [ticket()], transitions: stuck });

    const outcome = await handBackTicket(ticket(), NOTE, { jira, logger, attemptCap: ATTEMPT_CAP });

    // A workflow with no way back to Open leaves the ticket held, which is the containment
    // `releaseTicket` chooses on purpose. The count still stands, and saying so is what stops a
    // caller counting it twice.
    expect(outcome).toMatchObject({ released: false, attemptCounted: true, reason: 'no-transition' });
    expect(jira.writes.filter((write) => write.kind === 'assign')).toStrictEqual([]);
  });
});
