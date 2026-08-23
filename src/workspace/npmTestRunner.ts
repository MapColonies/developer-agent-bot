import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildTestPlan, changedScripts, dependenciesChanged, TEST_SCRIPT_PRECEDENCE } from './testCommand';
import type { CommandResult, CommandRunner, TestPlan, TestPlanResult, TestRun, TestRunner } from './types';

const PASSED = 0;
const MANIFEST = 'package.json';
const INSTALLED = 'node_modules';
const LOCKFILE = 'package-lock.json';
/**
 * npm's own switch for "resolve and unpack, but run nobody's install hooks".
 *
 * Used on exactly one path — the install of a manifest the model has edited — and the reason is
 * whose code would otherwise run. The clone's own hooks are snapshotted and refused if they
 * moved (`changedScripts`), but a *dependency's* `postinstall` is not in the clone's manifest at
 * all: it arrives with whatever package the model named. Without this flag, adding one line to
 * `dependencies` is a shell in the worker's pod, which is the one thing `MODEL_TOOLS` is there
 * to prevent — and a deny list of tools would look silly next to it.
 *
 * The cost is real and accepted: a package that needs its install hook to be usable will not
 * work, so the suite fails or the import does, and the ticket is handed back for a person to
 * look at. A change that needs a package with a build step is a change worth a human anyway.
 */
const IGNORE_SCRIPTS = '--ignore-scripts';

/** What goes on the ticket when a clone states no test command. Names what was looked for. */
const NO_COMMAND = `Could not find a test command in ${MANIFEST}. One of these scripts must exist: ${TEST_SCRIPT_PRECEDENCE.join(', ')}.`;

/** What goes on the ticket when the change rewrote the thing that grades it. */
function verificationChanged(names: readonly string[]): string {
  return [
    `The change edited ${MANIFEST} scripts that the worker runs to verify it: ${names.join(', ')}.`,
    '',
    'The suite was not run and the change was not offered. A change that redefines its own test command cannot be verified by it,',
    'and a ticket that genuinely needs one of these scripts changed needs a person to agree to it.',
  ].join('\n');
}

/**
 * Which npm invocation installs this clone.
 *
 * Three cases, and only the first is about the model. `stale` means the manifest no longer
 * matches the lockfile, which in this worker means one thing: the model added a dependency. That
 * install resolves a package nobody has vetted, so it runs no scripts. The other two installs
 * are of the repository exactly as it was cloned — the same trust level as cloning it at all —
 * so they run normally, because a repo whose devDependencies need a build step has to be
 * testable.
 */
function installArgs(stale: boolean, clean: boolean): string[] {
  if (stale) {
    return ['install', IGNORE_SCRIPTS];
  }

  return clean ? ['ci'] : ['install'];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

/**
 * The clone's package.json, or null if it has none or it does not parse.
 *
 * Both cases read the same way on purpose: this runner only knows how to verify a Node
 * repository, and a clone it cannot read a manifest from is one it cannot judge. That is a
 * refusal, never an assumed pass — see `TestRun`.
 */
async function readManifest(dir: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Runs a cloned Node repository's own test suite.
 *
 * The command comes from the clone (see `inferTestCommand`), and the worker runs it rather
 * than the model: the model cannot report a pass it did not get, cannot skip the run, and
 * cannot decide the suite was not the important part. Reviewers being the first check is the
 * thing this ticket exists to stop, so the check has to belong to the side that is not also
 * writing the change.
 *
 * The command is also *fixed before the model starts* — `plan` is read from the pristine clone
 * and handed back in to `run`. Re-reading it afterwards would hand the model the marking scheme
 * along with the exam; see `TestPlan`.
 */
class NpmTestRunner implements TestRunner {
  public constructor(private readonly commands: CommandRunner) {}

  /** Read how this clone verifies itself. Call before the model runs, once. */
  public async plan(dir: string): Promise<TestPlanResult> {
    const plan = buildTestPlan(await readManifest(dir));

    return plan === null ? { ok: false, reason: 'no-command', output: NO_COMMAND } : { ok: true, plan };
  }

  public async run(dir: string, plan: TestPlan): Promise<TestRun> {
    const manifest = await readManifest(dir);
    const changed = changedScripts(plan, manifest);

    // Before the install, not after: `npm ci` and `npm install` execute the lifecycle scripts
    // themselves, so checking them afterwards would be checking whether the thing that already
    // ran was allowed to.
    if (changed.length > 0) {
      return { ok: false, reason: 'verification-changed', command: plan.command, output: verificationChanged(changed) };
    }

    const install = await this.install(dir, plan, manifest);

    if (install !== null) {
      // The suite never ran, so this says nothing about the change. Kept apart from a real
      // failure so a broken registry cannot read as a broken diff.
      return { ok: false, reason: 'install-failed', command: plan.command, output: install.output };
    }

    const result = await this.commands.run('npm', ['run', plan.script], dir);

    return result.code === PASSED
      ? { ok: true, command: plan.command, output: result.output }
      : { ok: false, reason: 'failed', command: plan.command, output: result.output };
  }

  /** Returns the failed install, or null when the clone is ready to test. */
  private async install(dir: string, plan: TestPlan, manifest: unknown): Promise<CommandResult | null> {
    // A ticket whose fix needs a package is an ordinary ticket, and the model has no shell to
    // install one with — so the worker has to notice. Two things follow from the manifest
    // having moved: the tree in `node_modules` is stale even though it exists, and `npm ci`
    // would refuse outright ("package.json and package-lock.json are not in sync"), throwing
    // away a working change and blaming the repository for it.
    const stale = dependenciesChanged(plan, manifest);

    // Attempt two runs in the same clone as attempt one, so unchanged dependencies are already
    // there. Reinstalling between attempts would be minutes of pod time per retry for a tree
    // that has not moved.
    if (!stale && (await exists(join(dir, INSTALLED)))) {
      return null;
    }

    // `npm ci` only while the lockfile still describes the manifest. Otherwise `npm install`,
    // which resolves the new range and rewrites the lockfile — and the rewritten lockfile is
    // part of the change the push slice will offer, which is what a human would have committed
    // too. Whether that install may run install hooks is a separate question — see
    // `installArgs`.
    const clean = !stale && (await exists(join(dir, LOCKFILE)));
    const installed = await this.commands.run('npm', installArgs(stale, clean), dir);

    return installed.code === PASSED ? null : installed;
  }
}

export { IGNORE_SCRIPTS, installArgs, NO_COMMAND, NpmTestRunner, verificationChanged };
