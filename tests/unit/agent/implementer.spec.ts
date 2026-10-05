import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConfigError } from '@src/agent/credential';
import { DEFAULT_AGENT_LIMITS, type ImplementDeps } from '@src/agent/implement';
import { createImplementer, type ImplementerOptions } from '@src/agent/implementer';
import type { DescriptionPort, ReleasePort } from '@src/agent/types';
import { fakeLogger } from '@tests/helpers/fakeLogger';

/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */
const WITH_KEY: NodeJS.ProcessEnv = { PATH: '/usr/bin', MODEL_AUTH: 'api-key', ANTHROPIC_API_KEY: 'sk-from-the-secret' };
const WITH_LOGIN: NodeJS.ProcessEnv = { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-of-a-person' };
/* eslint-enable @typescript-eslint/naming-convention */

const release: ReleasePort = { handBack: async (): Promise<{ ok: true }> => Promise.resolve({ ok: true }) };
const description: DescriptionPort = { read: async (): Promise<string> => Promise.resolve('') };

const dirs: string[] = [];

function options(env: NodeJS.ProcessEnv): ImplementerOptions {
  return { logger: fakeLogger().logger, description, env };
}

/** The per-ticket half, which arrives after the boot-time half has already been built. */
function forTicket(implementer: ReturnType<typeof createImplementer>): ImplementDeps {
  return implementer({ release });
}

describe('createImplementer', () => {
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
  });

  it('should refuse to build at all when the deployment supplied no API key.', () => {
    // At boot rather than mid-cycle: a worker that discovers this on its first ticket has
    // already claimed one.
    expect(() => createImplementer(options({}))).toThrow(AgentConfigError);
  });

  it('should refuse an API key that the configured mode did not ask for.', () => {
    // The operator mistake worth catching, now that `sdk` is the default: a deployment carrying
    // only ANTHROPIC_API_KEY meant to bill that account and never said so, and using it anyway
    // would bill an account nobody chose.
    /* eslint-disable-next-line @typescript-eslint/naming-convention -- environment variable names */
    expect(() => createImplementer(options({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-from-the-secret' }))).toThrow(
      /one mode's credential is never used for the other/u
    );
  });

  it('should build on a subscription token with no mode set, because sdk is the default.', () => {
    expect(() => createImplementer(options(WITH_LOGIN))).not.toThrow();
  });

  it('should come up with the conservative bounds when none were configured.', () => {
    const deps = forTicket(createImplementer(options(WITH_KEY)));

    expect(deps.limits).toStrictEqual(DEFAULT_AGENT_LIMITS);
  });

  it('should carry a configured bound through instead of the default.', () => {
    const deps = forTicket(createImplementer({ ...options(WITH_KEY), limits: { maxAttempts: 1, maxTurns: 5 } }));

    expect(deps.limits).toStrictEqual({ maxAttempts: 1, maxTurns: 5 });
  });

  it('should read the model credential once, at boot, rather than once per ticket.', () => {
    // The whole reason this is two calls: a worker with no credential must fail to come up, and
    // a per-ticket read would instead claim a ticket and discover it.
    const implementer = createImplementer(options(WITH_KEY));

    expect(forTicket(implementer).agent).toBe(forTicket(implementer).agent);
  });

  it("should hand each ticket its own hand-back, because the at-most-once latch is the ticket's.", () => {
    const implementer = createImplementer(options(WITH_KEY));
    const first: ReleasePort = { handBack: async (): Promise<{ ok: true }> => Promise.resolve({ ok: true }) };

    expect(implementer({ release: first }).release).toBe(first);
    expect(implementer({ release }).release).toBe(release);
  });

  it('should meter the agent for this ticket when the wiring asks it to.', () => {
    // Unmetered is only ever right in a test: in production every hand-off is charged to the
    // ticket's ledger, which is what stops one ticket eating the whole daily allowance.
    const implementer = createImplementer(options(WITH_KEY));
    const sentinel = { run: async (): Promise<never> => Promise.reject(new Error('not run')) };

    expect(implementer({ release, meter: () => sentinel }).agent).toBe(sentinel);
  });

  it('should wire a runner that reads the test command off a real clone.', async () => {
    // The point of building this in one place is that a caller cannot wire a runner that only
    // looks like one, so the test asks the assembled object about a directory on disk.
    const dir = await mkdtemp(join(tmpdir(), 'agent-bot-implementer-'));
    dirs.push(dir);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'some-service', scripts: { 'test:ci': 'vitest run' } }));

    const deps = forTicket(createImplementer(options(WITH_KEY)));

    await expect(deps.tests.plan(dir)).resolves.toMatchObject({ ok: true, plan: { command: 'npm run test:ci' } });
  });

  it('should refuse a clone that states no test command, without running anything.', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-bot-implementer-'));
    dirs.push(dir);

    const deps = forTicket(createImplementer(options(WITH_KEY)));

    await expect(deps.tests.plan(dir)).resolves.toMatchObject({ ok: false, reason: 'no-command' });
  });
});
