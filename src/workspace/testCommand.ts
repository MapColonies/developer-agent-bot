import type { TestPlan } from './types';

/**
 * The npm scripts that count as "run this repository's tests", best first.
 *
 * The order is a judgement about intent, not a preference:
 *
 * - `test:ci` first, because a repo only writes one when plain `test` is *not* the thing to
 *   run unattended — it is the script whose author already thought about a machine.
 * - `test` next: the npm convention, what CI runs for most repos, and what a maintainer means
 *   by "the tests".
 * - `test:unit` last, for repos that leave `test` undefined, or leave it as a watcher, and
 *   keep the runnable suite here. This repository is one of them in spirit — its own `test`
 *   runs both projects with coverage while `test:unit` is the fast half.
 *
 * Deliberately no `test:integration` and no `test:e2e`: those need services the worker's pod
 * does not have, and a suite that cannot pass in this container must not be what the work is
 * judged on.
 */
const TEST_SCRIPT_PRECEDENCE = ['test:ci', 'test', 'test:unit'] as const;

/**
 * `npm init`'s placeholder. It is present in a lot of repos that have no tests at all, and it
 * exits non-zero, so taking it at face value would fail every ticket in such a repo for a
 * reason that has nothing to do with the change.
 */
const NO_TEST_PLACEHOLDER = /no test specified/iu;

/**
 * The scripts npm runs by itself when the worker installs the clone's dependencies.
 *
 * These matter more than they look. `npm ci` and `npm install` execute them in a shell, in the
 * worker's pod, and they are read out of a manifest the model has write access to — so an
 * added `postinstall` is a shell the model was never given as a tool. Snapshotting them and
 * refusing when they differ is what keeps `MODEL_TOOLS` from being one file edit away from
 * meaningless.
 *
 * Listed rather than pattern-matched because npm's set is fixed and short. `prepack`/`postpack`
 * are in it because `prepare` implies them for local installs in some npm versions, and being
 * wrong in the harmless direction here costs a refusal, not a shell.
 */
const INSTALL_LIFECYCLE_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'postprepare',
  'prepublish',
  'prepack',
  'postpack',
  'dependencies',
] as const;

/**
 * The manifest keys that decide what gets installed.
 *
 * `overrides` is in the list because it rewrites the resolved tree without appearing in any
 * dependency block, and a change to it invalidates the lockfile exactly as a new dependency
 * does.
 */
const DEPENDENCY_BLOCKS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The `scripts` block, from a manifest that is only claimed to be one.
 *
 * Typed as `unknown` all the way down because the input is `JSON.parse` of a file from a
 * cloned repository: it can be a string, a number, or an object whose `scripts` is a boolean,
 * and none of that may be allowed to throw.
 */
function scriptsOf(manifest: unknown): Record<string, unknown> {
  if (!isRecord(manifest)) {
    return {};
  }

  const scripts = manifest['scripts'];

  return isRecord(scripts) ? scripts : {};
}

/** A script body as a comparable value. Anything that is not a string reads as absent. */
function bodyOf(scripts: Record<string, unknown>, name: string): string | null {
  const body = scripts[name];

  return typeof body === 'string' ? body : null;
}

/**
 * The npm script that runs a cloned repository's tests, or null if it has none.
 *
 * Inferred from the clone's own package.json rather than assumed, because "npm test" is not
 * universal even inside one organisation, and a hardcoded command turns "this repo names its
 * suite differently" into "the agent cannot work on this repo".
 *
 * Null is a normal answer and must stay one: it means the change cannot be verified here,
 * which is a reason to hand the ticket back rather than to trust an unverified diff.
 */
function inferTestCommand(manifest: unknown): string | null {
  const scripts = scriptsOf(manifest);

  return (
    TEST_SCRIPT_PRECEDENCE.find((name) => {
      const body = scripts[name];

      return typeof body === 'string' && body.trim() !== '' && !NO_TEST_PLACEHOLDER.test(body);
    }) ?? null
  );
}

/**
 * Every script npm will execute on the worker's behalf for one test command.
 *
 * The suite, the `pre`/`post` hooks npm chains around it whether or not anyone asked, and the
 * install lifecycle. A hook that does not exist yet is included on purpose — `pretest` being
 * absent is part of the plan, so adding one later is a change like any other.
 */
function executedScriptNames(script: string): string[] {
  return [...INSTALL_LIFECYCLE_SCRIPTS, `pre${script}`, script, `post${script}`];
}

/**
 * The dependency blocks, as one opaque string to compare later.
 *
 * Not parsed, not sorted, and not meant to be read: the only question ever asked of it is
 * "is this still what the lockfile was built from". Key order is part of the string, so
 * alphabetising the block reads as a change — which costs one `npm install` and never a wrong
 * answer, and that is the right direction to be wrong in.
 */
function dependencySnapshot(manifest: unknown): string {
  const source = isRecord(manifest) ? manifest : {};

  return JSON.stringify(DEPENDENCY_BLOCKS.map((block) => source[block] ?? null));
}

/**
 * The verification plan for a manifest, or null if it states no test command.
 *
 * Must be called on the clone as cloned. Calling it on a tree the model has edited is the
 * defect this whole shape exists to prevent — see `TestPlan`.
 */
function buildTestPlan(manifest: unknown): TestPlan | null {
  const script = inferTestCommand(manifest);

  if (script === null) {
    return null;
  }

  const scripts = scriptsOf(manifest);
  const executed: Record<string, string | null> = {};

  for (const name of executedScriptNames(script)) {
    executed[name] = bodyOf(scripts, name);
  }

  return { script, command: `npm run ${script}`, executed, dependencies: dependencySnapshot(manifest) };
}

/**
 * The scripts in the plan that the working tree no longer agrees with, by name.
 *
 * Empty is the normal answer. A non-empty one means the change under test rewrote part of how
 * it is graded, or added an install hook, and the honest response is to refuse the run rather
 * than to report whatever the rewritten command says.
 */
function changedScripts(plan: TestPlan, manifest: unknown): string[] {
  const scripts = scriptsOf(manifest);

  return Object.entries(plan.executed)
    .filter(([name, shipped]) => bodyOf(scripts, name) !== shipped)
    .map(([name]) => name);
}

/**
 * Did the manifest's dependencies move since it was cloned?
 *
 * True means the committed lockfile no longer describes the manifest — which is the normal
 * outcome of a ticket that needs a package, not a fault. The runner reads it to decide how to
 * install; nothing refuses a ticket over it.
 */
function dependenciesChanged(plan: TestPlan, manifest: unknown): boolean {
  return dependencySnapshot(manifest) !== plan.dependencies;
}

export {
  buildTestPlan,
  changedScripts,
  dependenciesChanged,
  executedScriptNames,
  inferTestCommand,
  INSTALL_LIFECYCLE_SCRIPTS,
  TEST_SCRIPT_PRECEDENCE,
};
