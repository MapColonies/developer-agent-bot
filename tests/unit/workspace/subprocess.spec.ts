import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SECRET_ENV_NAMES, spawnRunner, tail, withoutSecrets } from '@src/workspace/subprocess';

const PRINT_TOKEN = 'process.stdout.write(`github:${process.env.GITHUB_TOKEN ?? "absent"} anthropic:${process.env.ANTHROPIC_API_KEY ?? "absent"}`)';

describe('tail', () => {
  it('should leave short output alone.', () => {
    expect(tail('all fine', 100)).toBe('all fine');
  });

  it('should keep the end, where a failing suite says what broke.', () => {
    const kept = tail('aaaaaFAILED: 3 tests', 15);

    expect(kept).toContain('FAILED: 3 tests');
  });

  it('should say that it truncated, so a shortened log does not read as a suite that died mid-run.', () => {
    expect(tail('aaaaaaaaaaaaaaaaaaaa', 5)).toContain('truncated');
  });
});

/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */
describe('withoutSecrets', () => {
  it("should take away the worker's own credentials.", () => {
    const scrubbed = withoutSecrets({ GITHUB_TOKEN: 'ghp_x', GH_TOKEN: 'ghp_y', ANTHROPIC_API_KEY: 'sk-x', MCP_ATLASSIAN_URL: 'http://mcp/sse' });

    expect(scrubbed).toStrictEqual({});
  });

  it('should leave everything a process actually needs to run.', () => {
    const scrubbed = withoutSecrets({ PATH: '/usr/bin', HOME: '/home/node', CI: 'true' });

    expect(scrubbed).toStrictEqual({ PATH: '/usr/bin', HOME: '/home/node', CI: 'true' });
  });

  it('should keep NPM_TOKEN, because a clone with private dependencies cannot install without it.', () => {
    expect(withoutSecrets({ NPM_TOKEN: 'npm_x' })).toStrictEqual({ NPM_TOKEN: 'npm_x' });
  });

  it('should hand back only the one credential it is asked to keep.', () => {
    const scrubbed = withoutSecrets({ ANTHROPIC_API_KEY: 'sk-x', GITHUB_TOKEN: 'ghp_x' }, ['ANTHROPIC_API_KEY']);

    expect(scrubbed).toStrictEqual({ ANTHROPIC_API_KEY: 'sk-x' });
  });

  it('should not mutate the environment it was given.', () => {
    const env = { GITHUB_TOKEN: 'ghp_x' };

    withoutSecrets(env);

    expect(env.GITHUB_TOKEN).toBe('ghp_x');
  });

  it('should name the interactive-login credential, which is the one that could authenticate as a person.', () => {
    expect(SECRET_ENV_NAMES).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });
});

/* eslint-enable @typescript-eslint/naming-convention */

describe('spawnRunner', () => {
  it("should report a child's exit code rather than throwing.", async () => {
    const runner = spawnRunner();

    const result = await runner.run(process.execPath, ['-e', 'process.exit(3)'], tmpdir());

    expect(result.code).toBe(3);
  });

  it('should capture stdout and stderr together.', async () => {
    const runner = spawnRunner();

    const result = await runner.run(process.execPath, ['-e', 'process.stdout.write("out;"); process.stderr.write("err;")'], tmpdir());

    expect(result.output).toContain('out;');
    expect(result.output).toContain('err;');
  });

  it("should run the child without the worker's credentials in its environment.", async () => {
    // A cloned repository's test script is arbitrary code, and this is the test that says it
    // cannot read the token that would let it push.
    // eslint-disable-next-line @typescript-eslint/naming-convention -- environment variable names
    const runner = spawnRunner({ env: { ...process.env, GITHUB_TOKEN: 'ghp_secret', ANTHROPIC_API_KEY: 'sk-secret' } });

    const result = await runner.run(process.execPath, ['-e', PRINT_TOKEN], tmpdir());

    expect(result.output).toBe('github:absent anthropic:absent');
  });

  it('should report a command that does not exist as a non-zero exit, not a crash.', async () => {
    const runner = spawnRunner();

    const result = await runner.run('definitely-not-a-real-binary', [], tmpdir());

    expect(result.code).not.toBe(0);
  });

  it('should kill a child that outlives its timeout and never report it as a pass.', async () => {
    const runner = spawnRunner({ timeoutMs: 100 });

    // A watch-mode test script is the realistic version of this: it never exits on its own.
    const result = await runner.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], tmpdir());

    expect(result.code).not.toBe(0);
  });
});
