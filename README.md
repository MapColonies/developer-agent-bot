# developer-agent-bot

Pulls `agent-ready` Jira tickets from the MAPCO project, implements them, and opens pull
requests. Designed in [MAPCO-11374](https://mapcolonies.atlassian.net/browse/MAPCO-11374),
substrate decided in [MAPCO-11377](https://mapcolonies.atlassian.net/browse/MAPCO-11377).

**Current slice: MAPCO-11429.** It polls and reports. It claims nothing, writes nothing to
Jira, and touches no repository.

## Shape

A long-lived process with an internal scheduler — deliberately *not* an OpenShift CronJob.
A ticket in flight belongs to a process that is still alive, which keeps "boot" a rare
event (a crash, a redeploy, an eviction) rather than something that happens every tick.

It is outbound-only. No Service, no Route, no Ingress, no HTTP probes — there is nothing to
probe, which is also how it satisfies MAPCO-11430's requirement that probes neither restart
an idle pod between runs nor kill one mid-run.

Jira is the sole source of truth. There is no database and nothing on disk outlives a run.

### The seam

`runCycle()` in `src/cycle.ts` is one complete run, and it is the single seam the whole
pipeline is built and tested through. The scheduler calls it; so do the tests. Later slices
add cases here rather than standing up harnesses of their own.

### Jira access

Through the org's self-hosted `atlassian-write` MCP server, in-cluster — the worker carries
no Jira credentials of its own.

Every Jira call is **worker code**, never model tooling. The Agent SDK gets file and test
tools only, so claiming, releasing and the attempt cap are not things the model can decline
to do. Same principle as MAPCO-11436's rule about git: a prompt that says "never push to
master" enforces nothing.

## Things that look wrong but aren't

Verified against the live Jira instance in MAPCO-11427, and each one bit a first draft:

- **Finished work is excluded by status *name*, not `statusCategory`.** `Resolved` reports
  category `In Progress` in this instance, so a category filter hands the worker
  already-finished tickets.
- **The poll asks for one more ticket than it needs.** The MCP server's `total` is always
  `-1`, so a full page is otherwise indistinguishable from an exhausted queue.
- **`labels not in (...)` also excludes unlabelled issues.** Harmless in the poll, because
  `labels = agent-ready` already guarantees a non-empty label set. Any query that drops the
  agent-ready clause must add `labels is EMPTY OR ...` back.
- **No `project = MAPCO` clause.** The server auto-bounds the query, wrapping it as
  `(<ours>) AND project = MAPCO`, so top-level `OR` is safe.
- **Transitions are resolved per issue, never cached.** Transition ids are not portable
  across issue types: id `4` starts work on a Tech Requirement and *ends* it on a Task.

## Ticket titles

The repo a ticket is about comes from its title: `<repo-name>: <feature title>`.

Only the part before the **first** colon is the repo name, so a feature title may contain
colons of its own. GitHub matches names case-insensitively, and the worker adopts the
canonical spelling it answers with — the casing in a ticket title never reaches a clone URL
or a branch name.

A title with no prefix, a prefix that is prose rather than a name, or a name that matches no
repo in the org is a **refusal**, never a guess: the worker comments what it looked for,
releases the ticket and bumps the attempt count. Most existing MAPCO tickets have no prefix,
so refusal is the common path until the convention spreads.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MCP_ATLASSIAN_URL` | *required* | Address of the `atlassian-write` MCP server. Transport is picked from the path: `/sse` gets SSE, anything else Streamable HTTP |
| `POLL_INTERVAL_MS` | `300000` | How often a cycle runs |
| `MAX_TICKETS_PER_RUN` | `1` | Tickets one cycle may start |
| `MAX_CONCURRENT_TICKETS` | `1` | Tickets in flight at once |
| `GITHUB_TOKEN` | *optional* | Bearer token for repo lookups. A PAT locally; a short-lived App installation token in the cluster once MAPCO-11428 lands. Unauthenticated works at a lower rate limit |

Raise `MAX_TICKETS_PER_RUN` before ever raising `MAX_CONCURRENT_TICKETS`.

## Known gaps

- The worker knobs are read from the environment rather than `@map-colonies/config`, which
  needs a schema published in `@map-colonies/schemas`. Telemetry still goes through the
  library. Registering a real schema is follow-up work.
- **The Jira identity is the shared MCP service account.** It has no per-user attribution,
  so the optimistic claim check (MAPCO-11431) cannot distinguish this worker from any other
  session using the same MCP, and boot-time orphan release (MAPCO-11432) could release a
  ticket someone else is working. A dedicated Jira account is the recommendation.
- `helm lint` needs the private `mclabels` dependency and fails without registry access.

## Dry run

One cycle against the real MCP server, from a laptop. Read-only. Requires the corporate
VPN — the server is not reachable from outside it.

```sh
MCP_ATLASSIAN_URL="https://atlassian-mcp-write.mapcolonies.net/sse" \
  GITHUB_TOKEN="$(gh auth token)" npm run dry-run
```

It runs the same `runCycle` seam the deployed worker runs, so what it proves is about the
worker rather than about the harness. It skips the scheduler, tracing and
`@map-colonies/config`, which the deployed entry point uses.

## Development

```sh
npm ci
npm test
npm run lint
npm run build
```
