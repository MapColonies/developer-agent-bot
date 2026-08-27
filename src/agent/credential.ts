/**
 * How the worker gets the credential it talks to the model with.
 *
 * This lives here rather than in `WorkerConfig` for one reason that is not tidiness: every
 * other field of `WorkerConfig` is safe to log, and this one is not. Keeping it out of that
 * object means the config a cycle carries around — and that ends up in a log line the day
 * someone logs it — never contains a credential. It is read once, at the entry point, and
 * handed straight to `AgentSettings`.
 *
 * There are two modes, and which one is in use is **explicit configuration, never inference**.
 * That is the whole design of this file. Both credentials look alike to the SDK and bill
 * completely differently: one draws on an organisation's Anthropic account, the other on a
 * person's Claude subscription. Picking whichever happened to be present in the environment
 * would make the billed party a property of the pod's env rather than of a decision, and the
 * failure is silent — a run that quietly spends someone's personal quota looks exactly like a
 * working one.
 *
 * ## ⚠️ `subscription` mode needs Anthropic's approval
 *
 * Anthropic's Agent SDK documentation states that, unless previously approved, claude.ai login
 * and its rate limits may not be used for products built on the Agent SDK. This module makes
 * the mode reachable because the operator asked for it; it cannot make it permitted. Whoever
 * sets `MODEL_AUTH=subscription` is asserting that this deployment has that approval.
 *
 * Three operational consequences, none of which code can fix:
 *
 * - Rate limits belong to the account, so the worker and that person's own interactive use
 *   share one quota and starve each other.
 * - Attribution is that person, not the worker — the same problem the README records for the
 *   shared Jira service account, now for the model too.
 * - Subscription tokens expire. When one lapses the pod crash-loops, by design (see below),
 *   rather than running on unclear credentials.
 */

/** The credential for an organisation's Anthropic account. Billed to that account. */
const API_KEY_ENV = 'ANTHROPIC_API_KEY';

/** The credential for a person's Claude subscription. Billed to, and rate-limited as, them. */
const SUBSCRIPTION_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

/** Selects which of the two the worker authenticates with. Defaults to the org-billed key. */
const AUTH_MODE_ENV = 'MODEL_AUTH';

type ModelAuthMode = 'api-key' | 'subscription';

const AUTH_MODES: readonly ModelAuthMode[] = ['api-key', 'subscription'];

const DEFAULT_AUTH_MODE: ModelAuthMode = 'api-key';

/** Which environment variable each mode reads, and nothing else may be substituted for it. */
const CREDENTIAL_ENV: Record<ModelAuthMode, string> = {
  'api-key': API_KEY_ENV,
  subscription: SUBSCRIPTION_ENV,
};

/**
 * The credential, carrying which kind it is.
 *
 * A tagged value rather than a bare string because the two are injected into the model's
 * subprocess under *different* variable names, and getting that wrong does not fail loudly —
 * the SDK simply finds no credential where it looked. See `modelEnv` in sdkOptions.ts.
 */
interface ModelCredential {
  readonly mode: ModelAuthMode;
  /** The variable it was read from. Reported in the boot log; the value never is. */
  readonly source: string;
  readonly value: string;
}

/**
 * A missing or unusable model credential.
 *
 * Distinct class rather than a bare `Error` for the same reason as `ConfigError` in
 * src/common/workerConfig.ts: this is a deployment fault, discovered at boot, and it must not
 * read as a ticket that failed.
 */
class AgentConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

function readMode(env: NodeJS.ProcessEnv): ModelAuthMode {
  const raw = env[AUTH_MODE_ENV]?.trim() ?? '';

  if (raw === '') {
    return DEFAULT_AUTH_MODE;
  }

  const mode = AUTH_MODES.find((candidate) => candidate === raw.toLowerCase());

  if (mode === undefined) {
    // Not a fallback to the default: a typo in the mode would silently bill the wrong party,
    // which is the exact failure this file exists to prevent.
    throw new AgentConfigError(`${AUTH_MODE_ENV} must be one of ${AUTH_MODES.join(', ')} — got '${raw}'.`);
  }

  return mode;
}

/**
 * The model credential, or a thrown `AgentConfigError`.
 *
 * Thrown rather than refused-as-a-value on purpose: a worker with no credential cannot do the
 * one thing it exists for, and every ticket it claimed in the meantime would be a claim burnt
 * for nothing. Boot is the cheapest place to find out.
 *
 * The mode's own variable is the *only* one consulted. The other mode's credential being
 * present is never a fallback, and is reported when the expected one is missing — a deployment
 * that set the token but not the mode is a likely mistake and worth naming, whereas quietly
 * using it would be the silent mis-billing this module refuses to allow.
 *
 * The env map is a parameter so tests drive it with plain objects, exactly as
 * `loadWorkerConfig` does — nothing in the suite mutates `process.env`.
 */
function readModelCredential(env: NodeJS.ProcessEnv = process.env): ModelCredential {
  const mode = readMode(env);
  const source = CREDENTIAL_ENV[mode];
  const value = env[source]?.trim() ?? '';

  if (value !== '') {
    return { mode, source, value };
  }

  // The other mode's credential, when that is the one that happens to be present. Naming it is
  // the actionable half of the message: setting a token and forgetting the mode is the mistake
  // an operator actually makes, and using it anyway is the silent mis-billing this refuses.
  const found = AUTH_MODES.filter((candidate) => candidate !== mode)
    .map((candidate) => CREDENTIAL_ENV[candidate])
    .filter((name) => (env[name]?.trim() ?? '') !== '');
  const hint =
    found.length > 0
      ? ` ${found.join(' and ')} is set, but ${AUTH_MODE_ENV} is '${mode}', and one mode's credential is never used for the other.`
      : '';

  throw new AgentConfigError(`${source} must be set — ${AUTH_MODE_ENV} is '${mode}' and the worker has no other way to reach the model.${hint}`);
}

export { AgentConfigError, API_KEY_ENV, AUTH_MODE_ENV, AUTH_MODES, CREDENTIAL_ENV, DEFAULT_AUTH_MODE, readModelCredential, SUBSCRIPTION_ENV };
export type { ModelAuthMode, ModelCredential };
