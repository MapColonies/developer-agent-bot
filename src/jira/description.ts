import type { DescriptionPort } from '../agent/types';
import type { JiraPort, JiraTicket } from './types';

/**
 * The implementation `DescriptionPort` (src/agent/types.ts) was declared without.
 *
 * Until this existed the honest stub returned `''` on every ticket, and `implementTicket` answers
 * an empty description by refusing the ticket *before the first model turn* — so every
 * `agent-ready` ticket in the queue was claimed, refused as `no-description` and handed back,
 * which is why labelling a ticket proved only that the claim and release plumbing worked.
 *
 * Read per claimed ticket rather than at poll time, which is the port's own argument and the
 * reason `POLL_FIELDS` still does not ask for a description: the poll fetches one more ticket
 * than it will work, and prose for a ticket nobody touches is paid for on every tick. The read
 * is `JiraPort.getIssue`, whose field list (`ISSUE_FIELDS`) is the one that asks for it.
 *
 * A missing description and a missing *issue* both answer `''`, because they are the same fact
 * from the model's side: there is nothing here to change code against. A read that *fails* is
 * not flattened into that — it throws, and `implementTicket` catches it and says so, because
 * "this ticket has no description" asks a human to write one while "the description could not be
 * read" asks them to fix the worker.
 */
function createDescriptionReader(jira: JiraPort): DescriptionPort {
  return {
    read: async (ticket: JiraTicket): Promise<string> => (await jira.getIssue(ticket.key))?.description ?? '',
  };
}

export { createDescriptionReader };
