import type { Logger } from '@map-colonies/js-logger';
import { budgetOf, type WorkerConfig } from '@common/workerConfig';
import { readApiKey } from './agent/apiKey';
import { DEFAULT_AGENT_LIMITS } from './agent/implement';
import { createImplementer } from './agent/implementer';
import type { AgentLimits } from './agent/types';
import { createBudgetGuard } from './budget/guard';
import type { AbortPort, AbortResult } from './budget/types';
import { ATTEMPT_CAP, type CycleDeps } from './cycle';
import { createDelivery } from './deliver';
import { RestGitHub } from './github/restGitHub';
import type { Repo } from './github/types';
import { createDescriptionReader } from './jira/description';
import type { JiraPort, JiraTicket } from './jira/types';
import { RestPullRequests } from './pr/restPullRequests';
import { handBackTicket, type HandBackDeps } from './tickets/handBack';
import { createHandBackOnce, type HandBackOnce } from './tickets/handBackOnce';
import { CliGit } from './vcs/cliGit';
import { CloneWorkspace } from './vcs/clone';
import { envTokenProvider, readGitHubToken } from './vcs/envToken';
import type { GitPort } from './vcs/types';

/**
 * The worker, assembled once at boot.
 *
 * This is the only place in the tree that decides what lives how long, and that is the whole
 * reason it exists as a file of its own rather than as a dozen `new`s in `index.ts` — three of
 * the lifetimes are load-bearing and two of them have already been the subject of a defect:
 *
 * - **Per process.** The budget guard, because the daily ticket counter is a property of the day
 *   and the process is what spans one. The agent, because building it is where the model
 *   credential is read and a worker with no credential must fail to come up rather than claim a
 *   ticket and discover it.
 * - **Per cycle.** The spend total on the "cycle complete" line. Reached through
 *   `budget.cycle()` inside `runCycle`, never here — holding it on the process's guard meant the
 *   figure never reset and a per-cycle field carried the lifetime total.
 * - **Per ticket.** The hand-back latch, because "a ticket is handed back at most once" is a
 *   per-ticket fact, and the metered agent, because it charges to one ticket's ledger.
 *
 * Everything below is plain construction in the same style as the rest of the worker path: no
 * container, no reflection, and the two entry points (`src/index.ts` for the deployment,
 * `src/dryRun.ts` for a laptop) differ only in what they do with the result.
 */

interface WorkerOptions {
  /** Jira, which is also the pull-request comment port and the description read. */
  readonly jira: JiraPort;
  readonly logger: Logger;
  readonly config: WorkerConfig;
  /** Read for credentials and scrubbed before anything the worker did not write sees it. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The turn and attempt bounds one hand-off gets, from the configured ceilings.
 *
 * `maxTurns` is the per-*ticket* ceiling deliberately, not a fraction of it: it is the bound the
 * SDK applies to a single hand-off, and no hand-off may be allowed to exceed what the whole
 * ticket is permitted. The cumulative total across hand-offs is the ledger's job — that is what
 * `meterAgent` charges — so the two together mean `MAX_TURNS_PER_TICKET` bounds both the deepest
 * a single hand-off can go and the sum of all of them, which is what the name says.
 *
 * `maxAttempts` is not configurable and stays at three. It is a judgement about convergence
 * rather than a spend ceiling — a model that has not got a suite passing on the third read of the
 * same failure is not converging — and the money is already bounded by the two ceilings above.
 */
function limitsFor(config: WorkerConfig): AgentLimits {
  return { maxAttempts: DEFAULT_AGENT_LIMITS.maxAttempts, maxTurns: budgetOf(config).ticket.maxTurns };
}

function createWorker(options: WorkerOptions): CycleDeps {
  const { jira, logger, config, env = process.env } = options;

  const handBackDeps: HandBackDeps = { jira, logger, attemptCap: ATTEMPT_CAP };

  /**
   * The overspend hand-back, bound to `handBackTicket` because both `AbortPort` and `ReleasePort`
   * say in as many words to bind to that one rather than write a second release path.
   *
   * It is the process-wide function rather than a ticket's latch because `createBudgetGuard` is
   * itself per process. What keeps the ticket from being handed back twice is the other
   * direction: `meterAgent` passes this call's result to the ticket's latch (`record`), so the
   * give-up that follows writes nothing. `HandBackOutcome` is already an `AbortResult`.
   */
  const abort: AbortPort = {
    abort: async (ticket: JiraTicket, note: string): Promise<AbortResult> => handBackTicket(ticket, note, handBackDeps),
  };

  // Both credentials are read here, at boot, and both values are deliberately thrown away —
  // nothing in this function holds one. The model key is checked first because its refusal is the
  // more specific ("never an interactive login"), and both are checked at all because the
  // alternative is discovering a missing Secret *per ticket*: a claim, a comment naming an
  // environment variable, and an attempt counted against somebody's ticket, twice over.
  readApiKey(env);
  readGitHubToken(env);

  const tokens = envTokenProvider(env);

  const delivery = createDelivery({
    github: new RestGitHub(env['GITHUB_TOKEN']),
    workspaces: new CloneWorkspace({ root: config.workspaceRoot, tokens, logger }),
    implementer: createImplementer({
      logger,
      description: createDescriptionReader(jira),
      limits: limitsFor(config),
      env,
      ...(config.model === undefined ? {} : { model: config.model }),
    }),
    pullRequests: new RestPullRequests(tokens),
    tickets: jira,
    git: ({ cwd, repo }: { cwd: string; repo: Repo }): GitPort => new CliGit({ cwd, repo, identity: config.commitIdentity, tokens }),
    logger,
  });

  return {
    jira,
    logger,
    config,
    delivery,
    budget: createBudgetGuard({ budget: budgetOf(config), abort, logger }),
    handBack: (): HandBackOnce => createHandBackOnce(handBackDeps),
  };
}

export { createWorker, limitsFor };
export type { WorkerOptions };
