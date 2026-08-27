import type { Logger } from '@map-colonies/js-logger';
import { NpmTestRunner } from '../workspace/npmTestRunner';
import { spawnRunner } from '../workspace/subprocess';
import { DEFAULT_AGENT_LIMITS, type ImplementDeps } from './implement';
import { createSdkAgent } from './sdkAgent';
import type { AgentLimits, DescriptionPort, ReleasePort } from './types';

/**
 * The whole of this slice, assembled once.
 *
 * `implementTicket` takes its collaborators as values, which is what makes it testable and also
 * what makes it four constructions to wire up. This is those four in one place: the SDK agent
 * with the key from the pod's Secret, the npm runner over a real subprocess, the turn and
 * attempt bounds, and the two ports the caller has to supply because this slice cannot —
 * handing a ticket back (MAPCO-11431) and reading a ticket's description.
 *
 * Kept beside the code it composes rather than in an entry point on purpose. `src/index.ts` and
 * `runCycle` belong to the wiring slice, and every collaborator they would otherwise construct
 * by hand is one more thing that can be wired subtly wrong — a `NpmTestRunner` built on a
 * command runner with no environment scrubbing, say, or an agent constructed with a key read
 * somewhere other than `readApiKey`. Calling this leaves them one line and no choices.
 */
interface ImplementerOptions {
  readonly logger: Logger;
  /** Comment, release, and count the attempt. See `ReleasePort` — the third step is owed. */
  readonly release: ReleasePort;
  /** Where the ticket's prose comes from. See `DescriptionPort`. */
  readonly description: DescriptionPort;
  /** Overridden only to spend less. The defaults are the conservative ones. */
  readonly limits?: AgentLimits;
  /** Read for the API key, and stripped of the worker's own secrets before the model sees it. */
  readonly env?: NodeJS.ProcessEnv;
  readonly model?: string;
}

/**
 * Everything `implementTicket` needs, built from the environment the pod was given.
 *
 * Throws `AgentConfigError` if there is no `ANTHROPIC_API_KEY`, which is why this belongs at
 * boot and not inside a cycle: a worker with no credential cannot do the one thing it exists
 * for, and finding that out mid-cycle means a ticket claimed and handed straight back. Failing
 * at start-up makes it a pod that will not come up — the loudest thing a missing Secret can be.
 */
function createImplementer(options: ImplementerOptions): ImplementDeps {
  const { logger, release, description, limits = DEFAULT_AGENT_LIMITS, env = process.env, model } = options;

  return {
    agent: createSdkAgent(env, model),
    tests: new NpmTestRunner(spawnRunner({ env })),
    description,
    release,
    logger,
    limits,
  };
}

export { createImplementer };
export type { ImplementerOptions };
