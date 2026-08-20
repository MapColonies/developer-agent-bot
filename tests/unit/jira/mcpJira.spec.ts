/* eslint-disable @typescript-eslint/naming-convention -- these mirror the MCP server's wire format */
import { describe, expect, it } from 'vitest';
import { toTicket } from '@src/jira/mcpJira';

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
