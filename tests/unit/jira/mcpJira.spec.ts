/* eslint-disable @typescript-eslint/naming-convention -- these mirror the MCP server's wire format */
import { describe, expect, it } from 'vitest';
import { assigneeFields, ISSUE_FIELDS, labelsFields, POLL_FIELDS, toTicket, toTransition } from '@src/jira/mcpJira';

describe('toTicket', () => {
  it('should read an unassigned ticket as unclaimed, not as assigned to someone called Unassigned.', () => {
    // The server reports this as a display name rather than omitting the field, and the
    // claim check in MAPCO-11431 turns on "is the assignee absent" being answerable.
    const parsed = toTicket({ key: 'MAPCO-1', assignee: { display_name: 'Unassigned' } });

    expect(parsed.assignee).toBeNull();
  });

  it('should keep a real assignee.', () => {
    const parsed = toTicket({ key: 'MAPCO-1', assignee: { display_name: 'BROCHSTEIN RAZ' } });

    expect(parsed.assignee).toBe('BROCHSTEIN RAZ');
  });

  it('should treat an absent assignee as unclaimed.', () => {
    expect(toTicket({ key: 'MAPCO-1' }).assignee).toBeNull();
  });

  it('should default the labels the server omits when a ticket has none.', () => {
    expect(toTicket({ key: 'MAPCO-1' }).labels).toStrictEqual([]);
  });

  it('should read the fields the poll depends on.', () => {
    const parsed = toTicket({
      key: 'MAPCO-11507',
      summary: 'LLM-Configuration: this is a test ticket',
      labels: ['agent-ready'],
      status: { name: 'Open' },
      issue_type: { name: 'Task' },
    });

    expect(parsed).toStrictEqual({
      key: 'MAPCO-11507',
      summary: 'LLM-Configuration: this is a test ticket',
      issueType: 'Task',
      status: 'Open',
      labels: ['agent-ready'],
      assignee: null,
    });
  });

  it('should leave the description absent when nobody asked for one.', () => {
    // A ticket off the poll is never asked about its description, and an absent field must not
    // read as "this ticket has no description" — that is the refusal `implementTicket` makes
    // before spending anything, and it would then fire on every ticket in the queue.
    expect(toTicket({ key: 'MAPCO-1', summary: 'a: b' })).not.toHaveProperty('description');
  });

  it("should keep the ticket's prose when the read asked for it.", () => {
    expect(toTicket({ key: 'MAPCO-1', description: 'Make the retry actually retry.' }).description).toBe('Make the retry actually retry.');
  });

  it('should keep an explicitly empty description, which is a ticket with nothing on it.', () => {
    expect(toTicket({ key: 'MAPCO-1', description: '' }).description).toBe('');
  });
});

describe('the field lists', () => {
  it('should keep the description out of the poll and in the per-issue read.', () => {
    // The poll asks for one more ticket than it will work and drops the rest, so prose in
    // `POLL_FIELDS` is paid for on every tick for tickets nobody touches.
    expect(POLL_FIELDS).not.toContain('description');
    expect(ISSUE_FIELDS).toContain('description');
  });

  it('should ask a per-issue read for everything the poll asks for as well.', () => {
    // `getIssue` is also the claim's confirmation read, so it still has to answer the fields the
    // claim compares — narrowing it to just the description would break the optimistic claim.
    expect(ISSUE_FIELDS.split(',')).toEqual(expect.arrayContaining(POLL_FIELDS.split(',')));
  });
});

describe('assigneeFields', () => {
  it('should send the assignee as a JSON string, because that is what the tool takes.', () => {
    // `fields` is a *stringified* object on this API, not an object. Passing an object
    // silently updates nothing, which would make a claim look like it succeeded.
    expect(assigneeFields('developer-agent@mapcolonies.example')).toBe('{"assignee":"developer-agent@mapcolonies.example"}');
  });

  it('should send an explicit null to unassign, not an omitted field.', () => {
    expect(assigneeFields(null)).toBe('{"assignee":null}');
  });
});

describe('labelsFields', () => {
  it('should send the labels as a JSON string, because that is what the tool takes.', () => {
    expect(labelsFields(['agent-ready', 'agent-attempted-1'])).toBe('{"labels":["agent-ready","agent-attempted-1"]}');
  });

  it('should send the complete set, because the update overwrites rather than adds.', () => {
    // The attempt counter is the reason this matters: a write that dropped `agent-ready` would
    // un-enrol the ticket, and enrolment is a human's decision.
    expect(labelsFields([])).toBe('{"labels":[]}');
  });
});

describe('toTransition', () => {
  it('should keep the status a transition lands in, which is what the worker matches on.', () => {
    // Transition *names* are verbs on a real workflow — "Start Progress", not "In Progress" —
    // so the target status is the only reliable way to ask for "get me to In Progress".
    expect(toTransition({ id: 21, name: 'Start Progress', to: { name: 'In Progress' } })).toStrictEqual({
      id: '21',
      name: 'Start Progress',
      to: 'In Progress',
    });
  });

  it('should accept a target status reported as a bare string.', () => {
    expect(toTransition({ id: '11', name: 'Reopen', to: 'Open' }).to).toBe('Open');
  });

  it('should leave the target status absent when the server does not report one.', () => {
    expect(toTransition({ id: '11', name: 'Open' }).to).toBeUndefined();
  });
});
