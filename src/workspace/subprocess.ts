import { spawn } from 'node:child_process';
import type { CommandResult, CommandRunner } from './types';

/** Fifteen minutes. Long enough for `npm ci` plus a real suite, short enough to lose a pod to. */
const DEFAULT_TIMEOUT_MS = 900_000;
/**
 * Kept small on purpose. Everything captured here ends up in a pod log line and, on a
 * failure, inside the next attempt's prompt — so it is billed as well as stored.
 */
const DEFAULT_OUTPUT_LIMIT = 8_000;
/** What `timeout(1)` uses. A killed child reports no exit code of its own. */
const TIMED_OUT = 124;
/** No exit code at all: the binary was not there, or the cwd was not. */
const FAILED_TO_SPAWN = 127;

/**
 * Environment variables the worker holds that nothing it runs has any business reading.
 *
 * Both things this module starts — the model's own process and a cloned repository's test
 * script — execute code the worker did not write. A test script is arbitrary code by
 * definition: running a repo's tests *is* running its code. Stripping the credentials it does
 * not need is the cheap half of containing that; the other half is the pod being
 * outbound-only with no inbound surface at all (MAPCO-11430).
 *
 * A denylist can never be complete, which is why it is not the only control. It is here to
 * make the obvious mistake — the model or a test script reading `GITHUB_TOKEN` and pushing
 * with it — impossible rather than merely disallowed.
 *
 * `NPM_TOKEN` is deliberately absent: a clone with private dependencies cannot install
 * without it, and an install that cannot run is a ticket that can never be verified.
 */
const SECRET_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  // An interactive-login credential. Present locally on a developer's machine, and the one
  // thing that could quietly turn "authenticate with an API key" into "authenticate as
  // whoever ran this".
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_PAT',
  // Not a credential itself, but the worker's private write path into Jira. Nothing inside a
  // clone has a reason to know it exists.
  'MCP_ATLASSIAN_URL',
  'JIRA_BOT_ACCOUNT',
] as const;

interface SpawnRunnerOptions {
  readonly timeoutMs?: number;
  readonly outputLimit?: number;
  /** The environment to derive the child's from. Injectable so a test can drive it with a plain object. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Keep the end, not the beginning.
 *
 * A failing suite prints its summary last, so the tail is the part that says what broke. The
 * marker matters: a silently shortened log reads as a suite that stopped mid-run.
 */
function tail(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `[earlier output truncated]\n${text.slice(text.length - limit)}`;
}

/**
 * A copy of `env` without the worker's secrets.
 *
 * `keep` is for the one process that legitimately needs one of them — the model's own, which
 * needs `ANTHROPIC_API_KEY` and nothing else on the list.
 */
function withoutSecrets(env: NodeJS.ProcessEnv, keep: readonly string[] = []): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...env };

  for (const name of SECRET_ENV_NAMES) {
    if (!keep.includes(name)) {
      delete scrubbed[name];
    }
  }

  return scrubbed;
}

/**
 * The real `CommandRunner`: one child process, its output captured, never a shell.
 *
 * `shell: false` is the point. The command and its arguments are assembled from a cloned
 * repository's package.json, which is untrusted input; handing that to a shell would make a
 * script *name* enough to run something else. The script *body* still runs in npm's own
 * shell, because that is what running a repo's tests means — but the worker does not add a
 * second injection point of its own on top of it.
 *
 * Failures resolve rather than reject: a non-zero exit, a timeout and a missing binary are
 * all just answers about the clone, and the caller turns them into a refusal.
 */
function spawnRunner(options: SpawnRunnerOptions = {}): CommandRunner {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, outputLimit = DEFAULT_OUTPUT_LIMIT, env = process.env } = options;

  return {
    run: async (command: string, args: readonly string[], cwd: string): Promise<CommandResult> =>
      new Promise<CommandResult>((resolve) => {
        const child = spawn(command, [...args], { cwd, env: withoutSecrets(env), shell: false, timeout: timeoutMs, killSignal: 'SIGKILL' });
        const chunks: string[] = [];
        const collect = (data: Buffer): void => {
          chunks.push(data.toString('utf8'));
        };

        child.stdout.on('data', collect);
        child.stderr.on('data', collect);

        child.on('error', (error: Error) => {
          resolve({ code: FAILED_TO_SPAWN, output: tail(`${chunks.join('')}${error.message}`, outputLimit) });
        });

        // `code` is null when the child was killed — the timeout above, or the pod going away
        // mid-run. Either way it did not pass, and it must not report as exit 0.
        child.on('close', (code: number | null) => {
          resolve({ code: code ?? TIMED_OUT, output: tail(chunks.join(''), outputLimit) });
        });
      }),
  };
}

export { DEFAULT_OUTPUT_LIMIT, SECRET_ENV_NAMES, spawnRunner, tail, withoutSecrets };
export type { SpawnRunnerOptions };
