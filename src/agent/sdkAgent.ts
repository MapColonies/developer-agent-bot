import { query } from '@anthropic-ai/claude-agent-sdk';
import { readModelCredential } from './credential';
import { buildTaskPrompt } from './prompt';
import { buildAgentOptions, foldMessages, type AgentQueryOptions, type AgentSettings } from './sdkOptions';
import type { AgentPort, AgentRun, AgentRunRequest } from './types';

/**
 * The SDK entry point, as this worker uses it.
 *
 * Narrower than the SDK's own `query` — a string prompt, options that are always present —
 * which is what lets a test drive `SdkAgent` with a recorder and prove that the options
 * `buildAgentOptions` produced are the ones the SDK is actually given. `query` is assignable to
 * it, and the compiler checks that at the one place it is bound, below.
 */
type RunQuery = (params: { prompt: string; options: AgentQueryOptions }) => AsyncIterable<unknown>;

/**
 * The Claude Agent SDK behind `AgentPort`.
 *
 * Everything interesting lives in `sdkOptions.ts`: what the model is allowed to touch, and
 * how its message stream reads as an outcome. What is left here is starting the run and
 * draining the stream, which is why this file is the size it is.
 *
 * Note what this class does *not* do. It does not retry, does not decide whether the change
 * is good, and does not touch Jira: an adapter that judged its own work would put the decision
 * on the far side of the seam the tests exercise.
 */
class SdkAgent implements AgentPort {
  public constructor(
    private readonly settings: AgentSettings,
    /** Injectable so the options-to-SDK seam is testable without the network. */
    private readonly runQuery: RunQuery = query
  ) {
    if (settings.credential.value.trim() === '') {
      // Failing here rather than at the first ticket. An empty credential means the
      // deployment's Secret did not arrive, and the worker discovering that mid-cycle would
      // burn a claim.
      throw new Error(`a model credential is required — ${settings.credential.source} was empty, and the worker has no other way to reach the model`);
    }
  }

  public async run(request: AgentRunRequest): Promise<AgentRun> {
    const prompt = buildTaskPrompt(request);
    const options = buildAgentOptions(request, this.settings);

    // The stream is bounded by `maxTurns`, so collecting it is bounded too. Kept whole rather
    // than folded as it arrives because reading it is a pure function over the run, and that
    // is the part worth having tests for.
    const messages: unknown[] = [];

    for await (const message of this.runQuery({ prompt, options })) {
      messages.push(message);
    }

    return foldMessages(messages);
  }
}

/**
 * An agent wired to the environment the pod was given.
 *
 * The one place the credential is read, so which account a run bills is a single line someone
 * can check rather than a claim. Which of the two credentials it reads is decided by
 * `MODEL_AUTH` inside `readModelCredential`, never by what happens to be set here — see that
 * module for why inference would be the wrong design, and for the approval `subscription` mode
 * requires.
 *
 * Composed at an entry point (src/index.ts, src/dryRun.ts) alongside `new McpJira(...)`, in the
 * same style as every other collaborator in the worker path: plain construction, no container.
 * That wiring is not part of this slice — the entry points also need the clone from MAPCO-11433
 * and the release path from MAPCO-11431 before there is anything to hand this.
 */
function createSdkAgent(env: NodeJS.ProcessEnv = process.env, model?: string): SdkAgent {
  return new SdkAgent({ credential: readModelCredential(env), model, env });
}

export { createSdkAgent, SdkAgent };
export type { RunQuery };
