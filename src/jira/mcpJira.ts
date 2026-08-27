/* eslint-disable import-x/no-unresolved -- the SDK's subpath exports resolve for tsc and node, but not for the eslint resolver */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
/* eslint-enable import-x/no-unresolved */
import { SERVICE_NAME } from '@common/constants';
import type { JiraPort, JiraTicket, JiraTransition } from './types';

const POLL_FIELDS = 'summary,status,labels,assignee,issuetype,created';

/* eslint-disable @typescript-eslint/naming-convention -- these mirror the MCP server's wire format */
interface McpTransition {
  id: number | string;
  name: string;
  to?: { name?: string } | string;
}

interface McpTicket {
  key: string;
  summary?: string;
  labels?: string[];
  status?: { name?: string };
  issue_type?: { name?: string };
  assignee?: { display_name?: string } | null;
}

/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Jira access via the org's self-hosted `atlassian-write` MCP server (MAPCO-11427).
 *
 * The worker holds no Jira credentials — that server already has them. It is reached
 * in-cluster, which is also why the worker needs no inbound Route of its own.
 */
class McpJira implements JiraPort {
  private client: Client | undefined;

  public constructor(private readonly url: string) {}

  public async search(jql: string, limit: number): Promise<JiraTicket[]> {
    // The server never returns a usable `total` — it is always -1 — so callers count the
    // array. Asking for one more than we need is how a caller distinguishes "that is all
    // of them" from "the page filled up".
    const raw = await this.call('jira_search', { jql, fields: POLL_FIELDS, limit });
    const parsed = JSON.parse(raw) as { issues?: McpTicket[] };

    return (parsed.issues ?? []).map(toTicket);
  }

  public async getIssue(issueKey: string): Promise<JiraTicket | null> {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- MCP wire format
    const raw = await this.call('jira_get_issue', { issue_key: issueKey, fields: POLL_FIELDS, comment_limit: 0 });
    const parsed = JSON.parse(raw) as McpTicket | null;

    return parsed?.key === undefined ? null : toTicket(parsed);
  }

  public async assign(issueKey: string, assignee: string | null): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- MCP wire format
    await this.call('jira_update_issue', { issue_key: issueKey, fields: assigneeFields(assignee) });
  }

  public async transition(issueKey: string, transitionId: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- MCP wire format
    await this.call('jira_transition_issue', { issue_key: issueKey, transition_id: transitionId });
  }

  public async addComment(issueKey: string, body: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- MCP wire format
    await this.call('jira_add_comment', { issue_key: issueKey, body });
  }

  public async setLabels(issueKey: string, labels: readonly string[]): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- MCP wire format
    await this.call('jira_update_issue', { issue_key: issueKey, fields: labelsFields(labels) });
  }

  public async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- MCP wire format
    const raw = await this.call('jira_get_transitions', { issue_key: issueKey });
    const parsed = JSON.parse(raw) as McpTransition[];

    return parsed.map(toTransition);
  }

  public async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }

  private async connect(): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    const client = new Client({ name: SERVICE_NAME, version: '1.0.0' });
    await client.connect(createTransport(this.url));
    this.client = client;

    return client;
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<string> {
    const client = await this.connect();
    const result = await client.callTool({ name: tool, arguments: args });

    const content = (result.content as { type: string; text?: string }[] | undefined) ?? [];
    const text = content.find((part) => part.type === 'text')?.text;

    if (text === undefined) {
      throw new Error(`${tool} returned no text content`);
    }

    // The server wraps tool output as {"result": "<json string>"}.
    const unwrapped = JSON.parse(text) as { result?: string };

    return unwrapped.result ?? text;
  }
}

/**
 * The deployed `mcp-atlassian` serves SSE at `/sse`. Streamable HTTP is the newer
 * transport and the one a future deployment is likelier to use, so pick by the URL rather
 * than pinning either.
 */
function createTransport(url: string): SSEClientTransport | StreamableHTTPClientTransport {
  const parsed = new URL(url);

  return parsed.pathname.endsWith('/sse') ? new SSEClientTransport(parsed) : new StreamableHTTPClientTransport(parsed);
}

/** The server reports an unassigned ticket as a display name, not as an absent assignee. */
const UNASSIGNED = 'Unassigned';

function toAssignee(displayName: string | undefined): string | null {
  if (displayName === undefined || displayName === UNASSIGNED) {
    return null;
  }

  return displayName;
}

/**
 * The `fields` argument of `jira_update_issue`, which takes a JSON *string* rather than an
 * object. Passing an object updates nothing and still reports success, which would make a
 * failed claim look like it held — so this is its own named, tested function.
 */
function assigneeFields(assignee: string | null): string {
  return JSON.stringify({ assignee });
}

/**
 * The `fields` argument for a label write. A JSON *string*, for the same reason as
 * `assigneeFields` — an object updates nothing and still reports success.
 *
 * `jira_update_issue` overwrites the fields it is given, so this sends the complete set. The
 * array is copied rather than passed through: `JSON.stringify` on a `readonly string[]` is
 * fine, but the copy keeps the wire payload a plain array whatever the caller held.
 */
function labelsFields(labels: readonly string[]): string {
  return JSON.stringify({ labels: [...labels] });
}

/** The server reports a transition's target status as an object, or sometimes not at all. */
function toTransition(transition: McpTransition): JiraTransition {
  const to = typeof transition.to === 'string' ? transition.to : transition.to?.name;

  return { id: String(transition.id), name: transition.name, to };
}

function toTicket(issue: McpTicket): JiraTicket {
  return {
    key: issue.key,
    summary: issue.summary ?? '',
    issueType: issue.issue_type?.name ?? 'unknown',
    status: issue.status?.name ?? 'unknown',
    // The server omits `labels` entirely when a ticket has none.
    labels: issue.labels ?? [],
    assignee: toAssignee(issue.assignee?.display_name),
  };
}

export { assigneeFields, labelsFields, McpJira, toTicket, toTransition };
export type { McpTicket, McpTransition };
