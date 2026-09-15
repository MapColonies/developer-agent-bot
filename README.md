# developer-agent-bot

Pulls `agent-ready` Jira tickets from the MAPCO project, implements them, and opens pull
requests. Designed in [MAPCO-11374](https://mapcolonies.atlassian.net/browse/MAPCO-11374),
substrate decided in [MAPCO-11377](https://mapcolonies.atlassian.net/browse/MAPCO-11377).

**Current slice: MAPCO-11434.** On top of the claim/release cycle (MAPCO-11431) it can now
hand a claimed ticket to the Claude Agent SDK, let the model change a clone, and run that
clone's own tests before anyone sees the diff. Nothing is committed, nothing is pushed, and
no branch is created — that is MAPCO-11436.

The pieces exist but are **not wired into `runCycle` yet**: labelling a ticket `agent-ready`
today still gets it claimed, commented and handed straight back. See *Known gaps*.

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

- **The chart sets `prometheus.enabled: false`** while almost every other MapColonies chart
  sets it true. This service has nothing to scrape: it is outbound-only, with no Service, no
  Route and no container port, and although `containerConfig.ts` builds a prom-client
  registry nothing ever serves it over HTTP. Left true, `mclabels` stamps
  `prometheus.io/scrape: "true"` with port 8080 and `/metrics` onto the pod and Prometheus
  gets a target that can only ever fail. Flip it the day something starts listening.
- **`mclabels.environment` is the only key that sets the environment label.** A
  `global.environment` or a top-level `environment` is ignored by the subchart, and leaving
  all three unset stamps the literal string `undefined` rather than omitting the label. The
  commented `#environment:` line in `helm/values.yaml` is where a deploy-time values file
  supplies it.

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
| `MODEL_AUTH` | `sdk` | Which account model calls are billed to: `sdk` or `api-key`. An unrecognised value refuses to start rather than falling back |
| `CLAUDE_CODE_OAUTH_TOKEN` | required for `sdk` | A Claude subscription token from `claude setup-token`, from a Secret. Billed to, and rate-limited as, that person — see the warning below |
| `ANTHROPIC_API_KEY` | required for `api-key` | Anthropic API key, from a Secret. Billed to that Anthropic account |

Raise `MAX_TICKETS_PER_RUN` before ever raising `MAX_CONCURRENT_TICKETS`.

The two bot-identity variables look redundant and are not: Jira takes an *identifier* on
write and hands back a *display name* on read, and neither is derivable from the other in
this instance. Set them inconsistently and every claim reads as lost.

### Which account pays for the model

`MODEL_AUTH` is explicit, and deliberately not inferred from whichever credential happens to
be present. Both credentials look alike to the SDK and bill completely differently, so letting
the environment decide would make the billed party a property of the pod rather than of a
decision — and the failure is silent, because a run that quietly spends someone's personal
quota looks exactly like a working one. One mode's credential is never used for the other; the
worker refuses to start and names the one it found.

> **⚠️ `sdk` needs Anthropic's approval, and is the default.** Anthropic's Agent SDK
> documentation states that, unless previously approved, claude.ai login and its rate limits
> may not be used for products built on the Agent SDK. Running this worker asserts that this
> deployment has that approval — the code cannot check it.

Three consequences of `sdk` mode that no code can fix:

- **Shared quota.** Rate limits belong to the account, so the worker and that person's own
  interactive Claude Code use starve each other.
- **Attribution.** Runs are that person's, not the worker's — the same problem this README
  already records for the shared Jira service account, now for the model too.
- **Expiry.** Subscription tokens lapse, and when one does the pod crash-loops rather than
  running on unclear credentials. That is the intended failure, not a bug.

`api-key` mode has none of these. It is one `MODEL_AUTH` away if the trade stops being
worth it — and note the flip side of the default: a deployment carrying only
`ANTHROPIC_API_KEY` now refuses to start rather than quietly using it.

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

## Implementing a ticket

A claimed ticket, a clone, and a bounded number of attempts. Each attempt hands the ticket to
the model, then runs the clone's own test command; an attempt counts as done only when that
command exits zero. Running out of attempts is a give-up, which already has a meaning —
comment, hand back, count the attempt.

### The model's tool surface is the control

`tools` is the SDK's base-set option, so the tools not named there are never built for the
session: there is no `Bash` to reach for, no subagent to delegate a `git push` to, and no MCP
server to be handed. `Bash`, `PowerShell`, the worktree tools, `Agent`/`Task`, the network
tools, `Skill` and `mcp__*` are denied by name as well, because a deny rule outranks every
other step of the permission evaluation.

`settingSources: []` with `strictMcpConfig` matters more than it looks. The clone is a
repository off the internet, and with the project source enabled its own
`.claude/settings.json` would be read as permission rules — letting the thing being worked on
widen what may be done to it. The cost is that the clone's `CLAUDE.md` is not loaded either,
which is a real loss of local convention and the right side of the trade.

There is a sentence in the prompt asking the model not to use git. It is documented as *not*
being the control; it is there so a model that goes looking is told why, and `deniedTools`
reports it in the run if one does.

### A write counts only when its result comes back

"The tree changed" is read from the `tool_result` that answers each write, paired by id — not
from the `tool_use` that requested it. Reading the attempt alone was a real bug: an `Edit`
whose `old_string` did not match, or a `Write` the permission layer refused, reported a
change, and the worker went on to test an unmodified clone, watch it pass, and certify a
verified diff that did not exist. A call that was denied, or that the run never got back to,
has no result at all and counts as no change.

### The test plan is taken before the model runs

The command is inferred from the pristine clone's `package.json` (`test:ci` → `test` →
`test:unit`, npm's placeholder script rejected) **before** the first hand-off, and every
attempt is graded against that snapshot — so a model cannot rewrite the command that grades
it. Install lifecycle scripts are compared before `npm ci` executes them, and a manifest the
model moved installs with `--ignore-scripts`.

## Known gaps

- **Nothing is wired into `runCycle`.** `implementTicket` has no caller: `src/cycle.ts` still
  claims a ticket and hands it straight back. The slice is a library with tests, not a
  behaviour the deployed worker has. Wiring it needs the clone step (MAPCO-11433) to produce
  a working directory and `ReleasePort` bound to `handBackTicket`.
- **`DescriptionPort` has no implementation.** The poll does not fetch a description and
  `JiraTicket` carries none, so there is no way to hand the model the ticket's prose — every
  ticket is refused before the first model turn. Closing it is `description` in `POLL_FIELDS`,
  on `McpTicket`, in `toTicket` and on `JiraTicket`.
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
- **Rendering the chart needs a credential you must supply yourself.** The `mclabels`
  dependency lives in a private ACR (`oci://acrarolibotnonprod.azurecr.io/helm/infra`) that
  **rejects anonymous pull** — an unauthenticated `helm dependency build` fails with
  `401 Unauthorized` from the registry's token endpoint. Once you are logged in, the rest is
  repeatable:

  ```sh
  # One-time, per machine. Use your own ACR credential — an AAD login:
  az acr login --name acrarolibotnonprod
  # ...or a registry token / service principal, if that is what you were issued:
  helm registry login acrarolibotnonprod.azurecr.io
  # Then, from the repo root:
  helm dependency build helm
  helm lint helm
  helm template t helm --set worker.modelSecretName=test-secret
  ```

  `helm dependency build` writes `helm/charts/mclabels-<version>.tgz`. That is a build
  artifact: it is covered by the root `.gitignore` `*.tgz` rule and must never be committed.

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
