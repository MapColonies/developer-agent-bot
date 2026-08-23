import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConfigError } from '@src/agent/apiKey';
import { DEFAULT_AGENT_LIMITS } from '@src/agent/implement';
import { createImplementer, type ImplementerOptions } from '@src/agent/implementer';
import type { DescriptionPort, ReleasePort } from '@src/agent/types';
import { fakeLogger } from '@tests/helpers/fakeLogger';

/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */
const WITH_KEY: NodeJS.ProcessEnv = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-from-the-secret' };
const WITH_LOGIN: NodeJS.ProcessEnv = { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-of-a-person' };
/* eslint-enable @typescript-eslint/naming-convention */

const release: ReleasePort = { handBack: async (): Promise<{ ok: true }> => Promise.resolve({ ok: true }) };
const description: DescriptionPort = { read: async (): Promise<string> => Promise.resolve('') };

const dirs: string[] = [];

function options(env: NodeJS.ProcessEnv): ImplementerOptions {
  return { logger: fakeLogger().logger, release, description, env };
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

  it('should refuse an interactive login rather than authenticating as a person.', () => {
    expect(() => createImplementer(options(WITH_LOGIN))).toThrow(/never as whoever logged in/u);
  });

  it('should come up with the conservative bounds when none were configured.', () => {
    const deps = createImplementer(options(WITH_KEY));

    expect(deps.limits).toStrictEqual(DEFAULT_AGENT_LIMITS);
  });

  it('should carry a configured bound through instead of the default.', () => {
    const deps = createImplementer({ ...options(WITH_KEY), limits: { maxAttempts: 1, maxTurns: 5 } });

    expect(deps.limits).toStrictEqual({ maxAttempts: 1, maxTurns: 5 });
  });

  it('should wire a runner that reads the test command off a real clone.', async () => {
    // The point of building this in one place is that a caller cannot wire a runner that only
    // looks like one, so the test asks the assembled object about a directory on disk.
    const dir = await mkdtemp(join(tmpdir(), 'agent-bot-implementer-'));
    dirs.push(dir);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'some-service', scripts: { 'test:ci': 'vitest run' } }));

    const deps = createImplementer(options(WITH_KEY));

    await expect(deps.tests.plan(dir)).resolves.toMatchObject({ ok: true, plan: { command: 'npm run test:ci' } });
  });

  it('should refuse a clone that states no test command, without running anything.', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-bot-implementer-'));
    dirs.push(dir);

    const deps = createImplementer(options(WITH_KEY));

    await expect(deps.tests.plan(dir)).resolves.toMatchObject({ ok: false, reason: 'no-command' });
  });
});
