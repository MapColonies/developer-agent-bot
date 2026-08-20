import { describe, expect, it } from 'vitest';
import { buildPollQuery } from '@src/jira/query';

describe('buildPollQuery', () => {
  it('should exclude finished work by status name, never by status category.', () => {
    const jql = buildPollQuery(2);

    // `statusCategory != Done` is the tempting form and it is wrong here: Resolved
    // reports category "In Progress" in this instance, so it would return finished work.
    expect(jql).not.toContain('statusCategory');
    expect(jql).toContain('status not in (Resolved, Closed, Done, Verified, Canceled, Rejected)');
  });

  it('should only exclude tickets that have reached the cap, not ones part-way to it.', () => {
    const jql = buildPollQuery(2);

    expect(jql).toContain('"agent-attempted-2"');
    expect(jql).not.toContain('"agent-attempted-1"');
  });

  it('should leave the project bound to the server, which supplies it.', () => {
    expect(buildPollQuery(2)).not.toContain('project');
  });

  it('should take the oldest ready ticket first.', () => {
    expect(buildPollQuery(2)).toContain('ORDER BY created ASC');
  });

  it('should only offer unclaimed tickets, since being unassigned is what availability means.', () => {
    expect(buildPollQuery(2)).toContain('assignee is EMPTY');
  });
});
