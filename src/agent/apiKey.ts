/**
 * How the worker gets the credential it talks to the model with.
 *
 * This lives here rather than in `WorkerConfig` for one reason that is not tidiness: every
 * other field of `WorkerConfig` is safe to log, and this one is not. Keeping it out of that
 * object means the config a cycle carries around — and that ends up in a log line the day
 * someone logs it — never contains a key. It is read once, at the entry point, and handed
 * straight to `AgentSettings`.
 *
 * The env var is the standard `ANTHROPIC_API_KEY`, which is what makes the deployment side of
 * this a `secretKeyRef` in the pod spec and nothing more:
 *
 * ```yaml
 * - name: ANTHROPIC_API_KEY
 *   valueFrom:
 *     secretKeyRef:
 *       name: {{ .Values.worker.anthropicSecretName }}
 *       key: apiKey
 * ```
 *
 * That block, and the README row that documents it, are the deployment half of MAPCO-11434's
 * first acceptance criterion. They live in `helm/templates/deployment.yaml`, `helm/values.yaml`
 * and `README.md`, none of which this slice owns — so the code half refuses to start without the
 * variable, which is the loudest thing it can do about a Secret that never arrives.
 */

/** The one variable the worker authenticates with. Set from a Secret in the cluster. */
const API_KEY_ENV = 'ANTHROPIC_API_KEY';

/**
 * Credentials that would let a run authenticate as a *person* rather than as the worker.
 *
 * Present on a developer's laptop, absent from the pod, and never a fallback. "Never an
 * interactive login" is an acceptance criterion, and the way that criterion is usually broken
 * is not by a decision but by a default: a library that quietly picks up whatever session
 * token it can find. The worker refuses instead, and says which variable it saw, because a
 * dry-run that silently billed a human's account would look exactly like a working one.
 *
 * These are stripped from the model's own subprocess environment as well — see
 * `SECRET_ENV_NAMES` in src/workspace/subprocess.ts.
 */
const LOGIN_ENV_NAMES = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'] as const;

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

/**
 * The API key, or a thrown `AgentConfigError`.
 *
 * Thrown rather than refused-as-a-value on purpose: a worker with no key cannot do the one
 * thing it exists for, and every ticket it claimed in the meantime would be a claim burnt for
 * nothing. Boot is the cheapest place to find out.
 *
 * The env map is a parameter so tests drive it with plain objects, exactly as
 * `loadWorkerConfig` does — nothing in the suite mutates `process.env`.
 */
function readApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env[API_KEY_ENV]?.trim() ?? '';

  if (key !== '') {
    return key;
  }

  const login = LOGIN_ENV_NAMES.filter((name) => (env[name]?.trim() ?? '') !== '');
  const instead =
    login.length > 0
      ? ` ${login.join(' and ')} ${login.length === 1 ? 'is' : 'are'} set, and will not be used instead: the worker authenticates as itself, never as whoever logged in.`
      : '';

  throw new AgentConfigError(`${API_KEY_ENV} must be set — the worker has no other way to reach the model.${instead}`);
}

export { AgentConfigError, API_KEY_ENV, LOGIN_ENV_NAMES, readApiKey };
