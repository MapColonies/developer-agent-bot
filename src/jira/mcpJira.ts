/* eslint-disable import-x/no-unresolved -- the SDK's subpath exports resolve for tsc and node, but not for the eslint resolver */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
/* eslint-enable import-x/no-unresolved */
import { SERVICE_NAME } from '@common/constants';
import type { JiraPort, JiraTicket, JiraTransition } from './types';

const POLL_FIELDS = 'summary,status,labels,assignee,issuetype,created';

/* eslint-disable @typescript-eslint/naming-convention -- these mirror the MCP server's wire format */
interface McpTicket {
  key: string;
  summary?: string;
  labels?: string[];
  status?: { name?: string };
  issue_type?: { name?: string };
  assignee?: { display_name?: string } | null;
}

/**
 * Jira access via the org's self-hosted `atlassian-write` MCP server (MAPCO-11427).
 *
 * The worker holds no Jira credentials — that server already has them. It is reached
 * in-cluster, which is also why the worker needs no inbound Route of its own.
 */
/* eslint-enable @typescript-eslint/naming-convention */

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

  public async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- MCP wire format
    const raw = await this.call('jira_get_transitions', { issue_key: issueKey });
    const parsed = JSON.parse(raw) as { id: number | string; name: string }[];

    return parsed.map((transition) => ({ id: String(transition.id), name: transition.name }));
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

export { McpJira, toTicket };
export type { McpTicket };
