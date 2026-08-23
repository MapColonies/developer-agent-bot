/** One finished child process: what it exited with and everything it printed. */
interface CommandResult {
  readonly code: number;
  /** stdout and stderr, interleaved as they arrived and capped — see `tail`. */
  readonly output: string;
}

/**
 * Running a command in a directory, as a port.
 *
 * Exists so the test runner can be unit-tested without spawning anything: the interesting
 * behaviour is which commands it decides to run and in what order, not `child_process`.
 */
interface CommandRunner {
  run: (command: string, args: readonly string[], cwd: string) => Promise<CommandResult>;
}

/**
 * How a clone verifies itself, read off the repository *before* the model touches it.
 *
 * This exists because of who edits what. The model is given `Write` and `Edit` over the whole
 * clone, package.json included, and the worker judges the change by a command it reads out of
 * that same file. Read it after the model has run and the model is defining its own exam: the
 * shortest path to a green run stops being "fix the code" and becomes `"test": "echo ok"`.
 *
 * So the plan is taken first and carried through every attempt. `executed` is the bodies of
 * every script npm will run on the worker's behalf — the suite, its `pre`/`post` hooks, and the
 * install lifecycle — as the repository shipped them; anything else in `scripts` is the
 * ticket's business and may change freely. `dependencies` is there for a different reason: if
 * the model added a package, the committed lockfile no longer describes the manifest, and the
 * runner has to install differently (see `NpmTestRunner.install`).
 */
interface TestPlan {
  /** The npm script name, chosen by `inferTestCommand` from the pristine manifest. */
  readonly script: string;
  /** `npm run <script>` — what goes in a log line and on the ticket. */
  readonly command: string;
  /** Bodies of the scripts npm executes for this plan, as shipped. `null` means "absent, and must stay absent". */
  readonly executed: Readonly<Record<string, string | null>>;
  /** The dependency blocks as shipped, opaquely. Only ever compared, never read. */
  readonly dependencies: string;
}

/**
 * The verification plan for a clone, or a refusal because it states none.
 *
 * Separate from `TestRun` because it is answered before any work happens: a repository the
 * worker cannot verify is one it must not spend a model run on at all.
 */
type TestPlanResult = { readonly ok: true; readonly plan: TestPlan } | { readonly ok: false; readonly reason: 'no-command'; readonly output: string };

/**
 * Why a test run did not pass.
 *
 * `failed` is the only one worth retrying — the suite ran and said no, which is information
 * the model can act on. The others mean the worker could not get a trustworthy answer at all,
 * and retrying produces the same non-answer: a repo with no test script will still have no
 * test script on the second attempt, and a model that has just rewritten the script that
 * grades it is not going to be talked out of it by being asked again.
 */
type TestFailure = 'failed' | 'no-command' | 'install-failed' | 'verification-changed';

/**
 * The outcome of running a repository's own tests.
 *
 * A refusal is a value, not an exception, and there is deliberately no third state for
 * "could not tell": anything that is not a pass is a reason not to count the work as done.
 * An unverifiable repo must never read as a passing one.
 */
type TestRun =
  | { readonly ok: true; readonly command: string; readonly output: string }
  | { readonly ok: false; readonly reason: TestFailure; readonly command: string | null; readonly output: string };

/**
 * Running the tests of whatever is in a directory.
 *
 * Two calls rather than one, and the split is the whole point: `plan` reads the repository as
 * it was cloned, `run` executes that plan against the working tree the model has since edited.
 * A single `run(dir)` would have to re-read the command from a file the model can write, which
 * is exactly the hole this shape closes.
 */
interface TestRunner {
  plan: (dir: string) => Promise<TestPlanResult>;
  run: (dir: string, plan: TestPlan) => Promise<TestRun>;
}

export type { CommandResult, CommandRunner, TestFailure, TestPlan, TestPlanResult, TestRun, TestRunner };
