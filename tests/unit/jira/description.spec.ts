import { describe, expect, it } from 'vitest';
import { createDescriptionReader } from '@src/jira/description';
import type { JiraPort, JiraTicket } from '@src/jira/types';
import { ticket } from '@tests/helpers/fakeJira';

/** A Jira that answers `getIssue` and refuses everything else, so the spec pins the one call used. */
function readingJira(answer: JiraTicket | null | Error): JiraPort & { asked: string[] } {
  const asked: string[] = [];

  return {
    asked,
    getIssue: async (issueKey: string): Promise<JiraTicket | null> => {
      asked.push(issueKey);

      if (answer instanceof Error) {
        throw answer;
      }

      return Promise.resolve(answer);
    },
    search: async (): Promise<JiraTicket[]> => Promise.reject(new Error('the description reader must not poll')),
    getTransitions: async (): Promise<never[]> => Promise.reject(new Error('the description reader must not read transitions')),
    assign: async (): Promise<void> => Promise.reject(new Error('the description reader must not write')),
    transition: async (): Promise<void> => Promise.reject(new Error('the description reader must not write')),
    addComment: async (): Promise<void> => Promise.reject(new Error('the description reader must not write')),
    setLabels: async (): Promise<void> => Promise.reject(new Error('the description reader must not write')),
  };
}

describe('createDescriptionReader', () => {
  it("should read the ticket's prose back by key.", async () => {
    const jira = readingJira(ticket({ key: 'MAPCO-77', description: 'Make the retry actually retry.' }));

    await expect(createDescriptionReader(jira).read(ticket({ key: 'MAPCO-77' }))).resolves.toBe('Make the retry actually retry.');
    expect(jira.asked).toStrictEqual(['MAPCO-77']);
  });

  it('should answer with nothing when the ticket carries no description.', async () => {
    // The refusal `implementTicket` is looking for: a ticket with no prose is one the model
    // could only guess at, and it is refused before a token is spent rather than after.
    const jira = readingJira(ticket({ key: 'MAPCO-77' }));

    await expect(createDescriptionReader(jira).read(ticket({ key: 'MAPCO-77' }))).resolves.toBe('');
  });

  it('should answer with nothing when the issue has gone.', async () => {
    // Deleted or moved between the poll and the read. Nothing to work from either way, and a
    // null that read as a crash would leave the ticket claimed with nothing said on it.
    const jira = readingJira(null);

    await expect(createDescriptionReader(jira).read(ticket())).resolves.toBe('');
  });

  it('should let a failed read surface rather than reporting it as an empty description.', async () => {
    // `implementTicket` contains this and tells the two apart on the ticket: "this ticket has no
    // description" asks a human to write one, "the description could not be read" asks them to
    // fix the worker. Swallowing the error here would put the wrong sentence on the ticket.
    const jira = readingJira(new Error('mcp unreachable'));

    await expect(createDescriptionReader(jira).read(ticket())).rejects.toThrow('mcp unreachable');
  });
});
