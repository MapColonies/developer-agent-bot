# developer-agent-bot

Pulls `agent-ready` Jira tickets from the MAPCO project, implements them, and opens pull
requests. Designed in [MAPCO-11374](https://mapcolonies.atlassian.net/browse/MAPCO-11374),
substrate decided in [MAPCO-11377](https://mapcolonies.atlassian.net/browse/MAPCO-11377).

**Current slice: MAPCO-11431.** It walks the whole Jira state machine with nothing in the
middle — it claims a ticket and hands it straight back with a comment. It touches no
repository and writes no code yet.

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
| `JIRA_BOT_ACCOUNT` | *required* | Identifier written to a ticket's assignee field — an email or accountId |
| `JIRA_BOT_DISPLAY_NAME` | *required* | What `JIRA_BOT_ACCOUNT` reads back as, surname-first. The claim re-read compares against this |
| `POLL_INTERVAL_MS` | `300000` | How often a cycle runs |
| `MAX_TICKETS_PER_RUN` | `1` | Tickets one cycle may start |
| `MAX_CONCURRENT_TICKETS` | `1` | Tickets in flight at once |
| `GITHUB_TOKEN` | *optional* | Bearer token for repo lookups. A PAT locally; a short-lived App installation token in the cluster once MAPCO-11428 lands. Unauthenticated works at a lower rate limit |

Raise `MAX_TICKETS_PER_RUN` before ever raising `MAX_CONCURRENT_TICKETS`.

The two bot-identity variables look redundant and are not: Jira takes an *identifier* on
write and hands back a *display name* on read, and neither is derivable from the other in
this instance. Set them inconsistently and every claim reads as lost.

## Claiming and releasing

Jira is the only state store — no database, no files that outlive a run — so there is no
lock to take. Claiming is **optimistic**:

1. Look up the transition into `In Progress` *before* writing anything. A workflow with no
   route in means the ticket can never be worked, and that is a refusal, not a half-claim.
   The lookup matches a transition's **target status**, not its name — transition names are
   verbs (`Start Progress`), so matching by name alone would refuse every ticket.
2. Write the assignee, then **read the issue back**. If the assignee is not the bot, a human
   got there first: back off, write nothing further, and do not try to take it back off
   them. Our write is already overwritten and is not ours to undo.
3. Transition to `In Progress`.

Releasing runs in the order comment → transition to `Open` → **unassign last**. That order
is deliberate and is the reverse of how it reads. Unassigning is what makes a ticket visible
to the poll query again (it filters `assignee is EMPTY`), so it goes last: if anything fails
part-way, the ticket is left held by the bot and `In Progress`, which the query skips and the
boot-time orphan sweep (MAPCO-11432) recovers. Unassigning first risks leaving a ticket
unassigned and `In Progress` — which polls straight back in, forever.

## Known gaps

- The worker knobs are read from the environment rather than `@map-colonies/config`, which
  needs a schema published in `@map-colonies/schemas`. Telemetry still goes through the
  library. Registering a real schema is follow-up work.
- **The Jira identity is configured, not discovered.** The MCP server runs under a shared
  service account with no per-user attribution, so the worker cannot ask Jira who it is —
  hence `JIRA_BOT_ACCOUNT` / `JIRA_BOT_DISPLAY_NAME`. The claim re-read can therefore tell
  the bot apart from a *human*, but not from a second worker configured with the same
  account. A dedicated Jira account per deployment is still the recommendation, and it is
  what makes boot-time orphan release (MAPCO-11432) safe.
- **The real transition vocabulary is unverified.** `jira_get_transitions` and
  `expand=transitions` are both rejected by the write-pilot MCP server, so the MAPCO
  workflow's actual transition names and target statuses could not be read the way the poll
  query was verified in MAPCO-11427. The lookup matches on target status with the
  transition name as a fallback, which covers both shapes, and a `no-transition` refusal
  logs the `offered` names — so the first real run reports the vocabulary rather than
  refusing in silence. Confirm it from that log line before trusting a deployment.
- `helm lint` needs the private `mclabels` dependency and fails without registry access.

## Dry run

One cycle against the real MCP server, from a laptop. Requires the corporate VPN — the
server is not reachable from outside it.

**This writes to real tickets.** It claims the oldest `agent-ready` ticket and hands it
straight back, leaving a comment behind. That is the point: label a ticket `agent-ready` and
watch it get claimed and returned.

```sh
MCP_ATLASSIAN_URL="https://atlassian-mcp-write.mapcolonies.net/sse" \
  JIRA_BOT_ACCOUNT="developer-agent@mapcolonies.net" \
  JIRA_BOT_DISPLAY_NAME="AGENT DEVELOPER" \
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
