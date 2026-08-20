/* eslint-disable @typescript-eslint/naming-convention -- these mirror the MCP server's wire format */
import { describe, expect, it } from 'vitest';
import { assigneeFields, toTicket, toTransition } from '@src/jira/mcpJira';

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
