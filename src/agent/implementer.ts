import type { Logger } from '@map-colonies/js-logger';
import { NpmTestRunner } from '../workspace/npmTestRunner';
import { spawnRunner } from '../workspace/subprocess';
import { DEFAULT_AGENT_LIMITS, type ImplementDeps } from './implement';
import { createSdkAgent } from './sdkAgent';
import type { AgentLimits, AgentPort, DescriptionPort, ReleasePort } from './types';

/**
 * The whole of this slice, assembled once.
 *
 * `implementTicket` takes its collaborators as values, which is what makes it testable and also
 * what makes it four constructions to wire up. This is those four in one place: the SDK agent
 * with the key from the pod's Secret, the npm runner over a real subprocess, the turn and
 * attempt bounds, and the description read the caller has to supply because this slice cannot.
 *
 * Kept beside the code it composes rather than in an entry point on purpose. `src/index.ts` and
 * `runCycle` belong to the wiring slice, and every collaborator they would otherwise construct
 * by hand is one more thing that can be wired subtly wrong — a `NpmTestRunner` built on a
 * command runner with no environment scrubbing, say, or an agent constructed with a credential
 * read somewhere other than `readModelCredential`. Calling this leaves them one line and no
 * choices.
 *
 * It is two calls rather than one because its collaborators have two different lifetimes, and
 * collapsing them was a real defect: the agent must be built **once, at boot**, because that is
 * where the model credential is read and a worker with no credential must fail to come up rather
 * than claim a ticket and discover it — while the hand-back belongs to **one ticket**, because
 * the guarantee that a ticket is handed back at most once is a per-ticket latch
 * (`createHandBackOnce`) and a shared one would refuse the next legitimate attempt on the same
 * ticket. So the expensive, credential-reading half happens here, and the ticket-scoped half
 * arrives per ticket.
 */
interface ImplementerOptions {
  readonly logger: Logger;
  /** Where the ticket's prose comes from. See `DescriptionPort`. */
  readonly description: DescriptionPort;
  /** Overridden only to spend less. The defaults are the conservative ones. */
  readonly limits?: AgentLimits;
  /** Read for the model credential, and stripped of every secret before the model sees it. */
  readonly env?: NodeJS.ProcessEnv;
  readonly model?: string;
}

/** What only the ticket in hand can supply. */
interface TicketScope {
  /** Comment, release, and count the attempt. See `ReleasePort` — the third step is owed. */
  readonly release: ReleasePort;
  /**
   * Decorates the boot-time agent for this one ticket.
   *
   * A function rather than a budget object so this module stays ignorant of the budget slice: the
   * wiring passes `meterAgent` (src/agent/meteredAgent.ts), which charges every hand-off to the
   * ticket's ledger and stops when it runs out. Omitted, the agent is handed over unmetered,
   * which is only ever right in a test.
   */
  readonly meter?: (agent: AgentPort) => AgentPort;
}

/** Everything `implementTicket` needs for one ticket, from a worker already built. */
type Implementer = (scope: TicketScope) => ImplementDeps;

/**
 * Build the worker's implement step from the environment the pod was given.
 *
 * Throws `AgentConfigError` if the credential for the configured `MODEL_AUTH` mode is missing,
 * which is why this belongs at boot and not inside a cycle: a worker with no credential cannot
 * do the one thing it exists for, and finding that out mid-cycle means a ticket claimed and
 * handed straight back. Failing at start-up makes it a pod that will not come up — the loudest
 * thing a missing Secret, or an expired subscription token, can be.
 */
function createImplementer(options: ImplementerOptions): Implementer {
  const { logger, description, limits = DEFAULT_AGENT_LIMITS, env = process.env, model } = options;

  const agent = createSdkAgent(env, model);
  const tests = new NpmTestRunner(spawnRunner({ env }));

  return (scope: TicketScope): ImplementDeps => ({
    agent: scope.meter === undefined ? agent : scope.meter(agent),
    tests,
    description,
    release: scope.release,
    logger,
    limits,
  });
}

export { createImplementer };
export type { Implementer, ImplementerOptions, TicketScope };
