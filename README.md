# developer-agent-bot

Pulls `agent-ready` Jira tickets from the MAPCO project, implements them, and opens pull
requests. Designed in [MAPCO-11374](https://mapcolonies.atlassian.net/browse/MAPCO-11374),
substrate decided in [MAPCO-11377](https://mapcolonies.atlassian.net/browse/MAPCO-11377).

**Current slice: the wiring.** Until now `runCycle` claimed a ticket and handed it straight
back, while a fully tested implement-and-verify core sat next to it that nothing called. The
two are now connected, so labelling a ticket `agent-ready` runs the whole thing: resolve the
repository, clone it, hand the ticket to the model inside that clone, run the repository's own
tests, and on a passing run push an `agent/` branch and open a pull request.

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

### What one ticket goes through

1. **Poll.** `agent-ready`, unassigned, not finished, not at the attempt cap.
2. **Claim**, optimistically, and only if the day still has room for a ticket. A run that has
   hit `MAX_TICKETS_PER_DAY` writes nothing at all.
3. **Resolve the repository** from the title's `<repo-name>: ` prefix, and refuse if it names
   none or names one that does not exist.
4. **Clone** it at the branch GitHub calls default, shallow, into a directory of its own.
5. **Implement**: read the ticket's description, hand it to the Agent SDK inside the clone, up
   to three hand-offs, feeding each test failure back into the next.
6. **Verify** with the repository's own test command — read off the clone *before* the model
   touched it, so the model cannot rewrite the thing that grades it.
7. **Publish**, and only on a passing run: branch, commit, push, open a normal pull request,
   comment the link on the ticket.
8. **Clean up** the clone, on every path.

Anything that stops before step 7 is a **hand-back**: a comment saying what happened, the
attempt counter bumped, and the ticket returned to Open. A ticket whose pull request *is* open
stays assigned to the bot — the work is done and a human is reviewing it, and releasing it
would put it back in the poll's way.

### Jira access

Through the org's self-hosted `atlassian-write` MCP server, in-cluster — the worker carries
no Jira credentials of its own.

Every Jira call is **worker code**, never model tooling. The Agent SDK gets file and test
tools only, so claiming, releasing and the attempt cap are not things the model can decline
to do. Same principle as MAPCO-11436's rule about git: a prompt that says "never push to
master" enforces nothing.

## Things that look wrong but aren't

Each one bit a first draft.

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
- **A transition is found by its name's second half, not by a target status.** This instance
  reports no target status at all — `jira_get_transitions` answers with `id` and `name` —
  and names its transitions `Open to In-Progress`. So the lookup reads the target out of a
  `<from> to <to>` name, and compares statuses with case, hyphens and whitespace flattened,
  because `In-Progress` and `In Progress` are the same status. Target status is still tried
  first and still wins where a server reports one: an entry that says it lands in `Blocked`
  is not matched for `In Progress` however it is named.
- **The poll does not fetch descriptions; the per-ticket read does.** A description is long,
  the poll asks for one more ticket than it will work, and prose for a ticket nobody touches
  would be paid for on every tick. So `POLL_FIELDS` omits it and `ISSUE_FIELDS` asks for it —
  and an *absent* description is therefore not the same fact as an empty one.
- **`MAX_TURNS_PER_TICKET` is charged in model turns, not in hand-offs.** A hand-off that took
  twelve turns charges twelve. Charging one per hand-off would make a ceiling of forty mean
  forty hand-offs of up to forty turns each.
- **Cache-read tokens count against `MAX_TOKENS_PER_TICKET`.** They are billed prompt tokens,
  and an agentic loop re-reads its whole context every turn — leaving them out would put most
  of what a ticket costs outside the ceiling that exists to bound it.
- **A ticket is handed back at most once, by a per-ticket latch.** Two slices each own a
  give-up path (the implement loop and the budget guard) and both can fire on one ticket. The
  second would otherwise comment again on a ticket already back in Open.

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

A ticket also needs a **description**. The summary alone is not something to change code
against without guessing, so a ticket with no prose is refused before the first model turn
rather than after paying for a hand-off whose only honest answer is "there is not enough here".

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MCP_ATLASSIAN_URL` | *required* | Address of the `atlassian-write` MCP server. Transport is picked from the path: `/sse` gets SSE, anything else Streamable HTTP |
| `JIRA_BOT_ACCOUNT` | *required* | Identifier written to a ticket's assignee field — an email or accountId |
| `JIRA_BOT_DISPLAY_NAME` | *required* | What `JIRA_BOT_ACCOUNT` reads back as, surname-first. The claim re-read compares against this |
| `MODEL_AUTH` | `sdk` | Which account model calls are billed to: `sdk` reads `CLAUDE_CODE_OAUTH_TOKEN`, `api-key` reads `ANTHROPIC_API_KEY`. Stated, never inferred — the worker refuses a credential its mode did not ask for |
| `CLAUDE_CODE_OAUTH_TOKEN` | *required in `sdk` mode* | A Claude subscription token from `claude setup-token`. Bills, and is rate-limited as, the person whose token it is |
| `ANTHROPIC_API_KEY` | *required in `api-key` mode* | The organisation's Anthropic key, from a Secret. The worker refuses to start without the credential its mode asks for |
| `GITHUB_TOKEN` | *required* | Repo lookups, cloning, pushing and opening the pull request. Checked at boot, like the model key: a public repo can be *cloned* without one but cannot be pushed, so a tokenless worker would fail after paying for the model rather than before. A PAT locally; interim until MAPCO-11428 mints App installation tokens per run |
| `POLL_INTERVAL_MS` | `300000` | How often a cycle runs |
| `MAX_TICKETS_PER_RUN` | `1` | Tickets one cycle may start |
| `MAX_CONCURRENT_TICKETS` | `1` | Tickets in flight at once. Each gets its own clone |
| `MAX_TOKENS_PER_TICKET` | `200000` | Per-ticket token ceiling, prompt and completion including cache reads. Going over aborts the ticket and comments what it cost |
| `MAX_TURNS_PER_TICKET` | `40` | Per-ticket model-turn ceiling, and also the turn bound on one hand-off |
| `MAX_TICKETS_PER_DAY` | `5` | Tickets the process may start in a day. Counted in memory, so it is per process-day |
| `WORKSPACE_ROOT` | `os.tmpdir()` | Where per-ticket clones are made. An `emptyDir` in the pod |
| `AGENT_GIT_NAME` | `mapcolonies-developer-agent[bot]` | Commit author and committer name |
| `AGENT_GIT_EMAIL` | `…[bot]@users.noreply.github.com` | Commit author and committer email |
| `AGENT_MODEL` | *unset* | Overrides the model. Unset means the worker's own default |

Raise `MAX_TICKETS_PER_RUN` before ever raising `MAX_CONCURRENT_TICKETS`.

None of the three spend ceilings has a value meaning "unlimited", on purpose: anything below
`1` is rejected, so a ceiling cannot be switched off with an env var. One that can is one that
gets switched off during an incident and stays off.

The two bot-identity variables look redundant and are not: Jira takes an *identifier* on
write and hands back a *display name* on read, and neither is derivable from the other in
this instance. Set them inconsistently and every claim reads as lost.

### Which account pays for the model

`MODEL_AUTH` is explicit, and deliberately not inferred from whichever credential happens to be
present. Both credentials look alike to the SDK and bill completely differently, so letting the
environment decide would make the billed party a property of the pod rather than of a decision —
and the failure is silent, because a run that quietly spends someone's personal quota looks
exactly like a working one. One mode's credential is never used for the other; the worker
refuses to start and names the one it found.

> **⚠️ `sdk` needs Anthropic's approval, and is the default.** Anthropic's Agent SDK
> documentation states that, unless previously approved, claude.ai login and its rate limits may
> not be used for products built on the Agent SDK. Running this worker asserts that this
> deployment has that approval — the code cannot check it.

Three consequences of `sdk` mode that no code can fix:

- **Shared quota.** Rate limits belong to the account, so the worker and that person's own
  interactive Claude Code use starve each other.
- **Attribution.** Runs are that person's, not the worker's — the same problem this README
  already records for the shared Jira service account, now for the model too.
- **Expiry.** Subscription tokens lapse, and when one does the pod crash-loops rather than
  running on unclear credentials. That is the intended failure, not a bug.

`api-key` mode has none of these. It is one `MODEL_AUTH` away if the trade stops being worth it
— and note the flip side of the default: a deployment carrying only `ANTHROPIC_API_KEY` refuses
to start rather than quietly using it.

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

A hand-back is that release **plus the attempt counter**, as one act. The counter lives in a
Jira label and is the only thing that ends a loop: a ticket handed back without it matches the
poll on the very next tick and is paid for again. So the counter is written *first*, and a
label write that fails stops the hand-back entirely — held-and-counted-nowhere is recoverable,
available-and-uncounted is a re-burn loop.

## What the model can and cannot do

The model gets `Read`, `Glob`, `Grep`, `Edit`, `Write`, `NotebookEdit` and `TodoWrite`, inside
the clone, and nothing else. No shell, no git, no network, no subagents, no MCP servers, and no
settings or skills files — not even the clone's own, because the clone is a repository off the
internet and its `.claude/settings.json` would otherwise widen what may be done to it.

Everything that touches the outside world is worker code: the branch name and commit title are
computed from the Jira issue, the push refuses any ref outside `agent/`, and there is no method
anywhere that merges, approves or force-pushes. The tests are run *by the worker*, against a
command read off the clone before the model started — so the model cannot report a pass it did
not get, skip the run, or make `"test": "echo ok"` the cheapest route to a green one.

## Known gaps

- The worker knobs are read from the environment rather than `@map-colonies/config`, which
  needs a schema published in `@map-colonies/schemas`. Telemetry still goes through the
  library. Registering a real schema is follow-up work.
- **The GitHub credential is a static token** (`GITHUB_TOKEN`) and is required rather than
  optional, not the per-run App installation token MAPCO-11428 specifies and `TokenProvider` is
  shaped for. `src/vcs/envToken.ts`
  is the interim binding and exists to be deleted; everything around it already treats the
  credential as short-lived — minted per call, never held, passed to git through the environment
  rather than argv, and redacted out of error messages.
- **The commit does not know which files the model wrote.** `AgentRun` reports *whether* the
  tree changed, not what changed, so the publish path commits every path `git status` reports
  and says so in the pull-request body and in the log. That is bounded — `status --porcelain`
  never reports an ignored file — but a repository that does not gitignore its build output can
  get a noisier diff than a human would have committed. Forwarding the paths the SDK already
  carries is what removes the branch.
- **Only Node repositories can be verified.** `NpmTestRunner` infers `test:ci`, `test` or
  `test:unit` from `package.json`; MAPCO-11433 also asks for Python (`pytest`). `TestRunner` is
  a port, so that is an implementation rather than a reshape, but it does not exist yet and a
  Python ticket is refused as `not-verifiable`.
- **The Jira identity is configured, not discovered.** The MCP server runs under a shared
  service account with no per-user attribution, so the worker cannot ask Jira who it is —
  hence `JIRA_BOT_ACCOUNT` / `JIRA_BOT_DISPLAY_NAME`. The claim re-read can therefore tell
  the bot apart from a *human*, but not from a second worker configured with the same
  account. A dedicated Jira account per deployment is still the recommendation, and it is
  what makes boot-time orphan release (MAPCO-11432) safe.
- **There is no boot-time orphan sweep yet** (MAPCO-11432). Several paths deliberately keep
  hold of a ticket they cannot return to Open, on the argument that the sweep recovers it —
  until it exists, such a ticket stays assigned to the bot. `runCycle` therefore hands a held
  ticket back on an unexpected failure rather than dropping it, but a hand-back that itself
  fails leaves the ticket held.
- **The *release* half of the transition vocabulary is still unverified.** The claim half is
  now known: `jira_get_transitions` works against the write pilot after all, and on an `Open`
  ticket it answers with `id` and `name` only — **no target status on any entry** — offering
  `Canceled`, `Blocked`, `Open to In-Progress`, `Open to Reject`, `Open to Verified`. The
  lookup reads the target out of that `<from> to <to>` shape, which is what makes a claim
  work. What nobody has seen yet is the set offered on an `In Progress` ticket, which is what
  a hand-back needs to get back to `Open` — so the first hand-back is still the thing that
  reports it, through the `offered` names on a `no-transition` refusal. The consequence of a
  miss there is worse than a refused claim: `releaseTicket` deliberately keeps hold of a
  ticket it cannot return to Open, and the orphan sweep that would recover it does not exist
  yet, so such a ticket stays assigned to the bot.
- **The Agent SDK on Alpine/musl is unverified.** The production image is
  `node:24-alpine`, and the SDK ships vendored binaries (ripgrep, which backs `Grep`) that are
  usually glibc-linked. A `Grep` that fails is a degraded session rather than a broken one —
  the model still has `Glob` and `Read` — but it is worth checking in the first pod logs.
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
  helm template t helm --set worker.anthropicSecretName=test-secret
  ```

  `helm dependency build` writes `helm/charts/mclabels-<version>.tgz`. That is a build
  artifact: it is covered by the root `.gitignore` `*.tgz` rule and must never be committed.

## Dry run

One cycle against the real MCP server, from a laptop. Requires the corporate VPN — the
server is not reachable from outside it.

**This is the whole pipeline, and it costs money.** It claims the oldest `agent-ready` ticket,
clones the repository its title names, hands the ticket to the model, runs that repository's
tests, and on a passing run pushes an `agent/` branch and opens a real pull request. It writes
to real tickets and bills real tokens. The spend ceilings apply, and because the daily counter
is per process a dry run gets its own allowance — so set them low for a first run.

```sh
MCP_ATLASSIAN_URL="https://atlassian-mcp-write.mapcolonies.net/sse" \
  JIRA_BOT_ACCOUNT="developer-agent@mapcolonies.net" \
  JIRA_BOT_DISPLAY_NAME="AGENT DEVELOPER" \
  MODEL_AUTH=sdk CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  GITHUB_TOKEN="$(gh auth token)" \
  MAX_TOKENS_PER_TICKET=50000 MAX_TURNS_PER_TICKET=15 MAX_TICKETS_PER_DAY=1 \
  npm run dry-run
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

`git` must be on `PATH`: two specs drive the real binary against a real bare repository, because
what they assert — that a push to `master` fails, that hooks cannot kill a commit, that
`--branch` checks out the branch GitHub named — is only true of real git.
