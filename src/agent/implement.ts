import type { Logger } from '@map-colonies/js-logger';
import { tail } from '../workspace/subprocess';
import type { TestRun, TestRunner } from '../workspace/types';
import { buildFailureReport } from './prompt';
import { addUsage, NO_USAGE } from './usage';
import type { AgentLimits, AgentPort, AgentRun, AgentRunRequest, AgentTask, Assignment, DescriptionPort, ReleasePort, TokenUsage } from './types';

/**
 * Three hand-offs: one to make the change, two to react to a failing suite.
 *
 * The number is a spending decision, not a belief about how many tries it takes. A model that
 * has not got a suite passing on the third read of the same failure is not converging, and the
 * ticket's own attempt cap (`ATTEMPT_CAP`, counted in Jira labels) is what gives it another go
 * later with a fresh context rather than another go now with a tired one.
 */
const DEFAULT_MAX_ATTEMPTS = 3;
/** Turn budget per hand-off. Enough for a small ticket in a real repo, not enough to wander. */
const DEFAULT_MAX_TURNS = 40;
const DEFAULT_AGENT_LIMITS: AgentLimits = { maxAttempts: DEFAULT_MAX_ATTEMPTS, maxTurns: DEFAULT_MAX_TURNS };

/** How much failing output goes on the ticket. The full run is in the pod logs. */
const NOTE_OUTPUT_LIMIT = 2_000;

/**
 * Why the worker stopped without a verified change.
 *
 * All of them end the same way — hand the ticket back — but they are different things to read
 * on a ticket six weeks later. `tests-failing` is the model not managing it; `no-description` is
 * a ticket with nothing on it to work from, refused before a token is spent; `no-change` is the
 * model reading a ticket it had prose for and finding nothing to do; `not-verifiable` is the
 * repository, not the change; `verification-changed` is the change having edited the command
 * that grades it, which is the one a person should actually look at; `agent-error` is the run
 * itself falling over.
 */
type GiveUpReason = 'tests-failing' | 'no-description' | 'no-change' | 'not-verifiable' | 'verification-changed' | 'agent-error';

type ImplementResult =
  | { readonly ok: true; readonly attempts: number; readonly usage: TokenUsage; readonly command: string }
  | { readonly ok: false; readonly reason: GiveUpReason; readonly attempts: number; readonly usage: TokenUsage; readonly released: boolean };

interface ImplementDeps {
  readonly agent: AgentPort;
  readonly tests: TestRunner;
  /** Where the ticket's prose comes from. See `DescriptionPort` — nothing implements it yet. */
  readonly description: DescriptionPort;
  readonly release: ReleasePort;
  readonly logger: Logger;
  readonly limits: AgentLimits;
}

/**
 * What the worker says on a ticket it could not finish.
 *
 * Written for whoever finds the ticket back in Open: what was tried, how far it got, and the
 * standing facts — nothing was pushed, no branch exists, and the clone the changes were made
 * in is gone. A note that only said "failed" would send a person looking for a branch that was
 * never created.
 */
function giveUpNote(reason: GiveUpReason, attempts: number, test: TestRun | undefined, summary: string): string {
  const attemptWord = attempts === 1 ? 'attempt' : 'attempts';
  // Zero attempts is a real case and worth saying plainly: the repository was refused before
  // any work was done, so there is nothing for a reader to go looking for.
  const opening =
    attempts === 0
      ? 'Picked this up automatically and did not start work on it.'
      : `Picked this up automatically and could not finish it, after ${attempts} ${attemptWord}.`;
  const lines = [opening, ''];

  if (reason === 'tests-failing' && test !== undefined) {
    lines.push(
      `The change was made, but \`${test.command ?? 'the test command'}\` did not pass. Its last output was:`,
      '',
      '{code}',
      tail(test.output.trim(), NOTE_OUTPUT_LIMIT),
      '{code}'
    );
  } else if (reason === 'no-description') {
    // Two ways to have no prose, and they ask different things of the reader: write a
    // description, or fix the worker. Saying which costs one line and saves a wrong guess.
    lines.push(
      summary === ''
        ? 'This ticket has no description, and its summary alone is not something to change code against without guessing. A few lines saying what should be different would be enough to pick it up again — no work was attempted and nothing was spent.'
        : `The ticket's description could not be read, so no work was attempted: ${summary}`
    );
  } else if (reason === 'no-change') {
    lines.push(
      'Nothing was changed: there was not enough here to act on without guessing. A description saying what should be different would probably be enough.'
    );
  } else if (reason === 'verification-changed') {
    lines.push(
      'The change was thrown away because it edited the scripts the worker uses to verify it:',
      '',
      '{code}',
      tail(test?.output.trim() ?? '', NOTE_OUTPUT_LIMIT),
      '{code}',
      '',
      'This is worth a look by a person. If the ticket really does need one of those scripts changed, it is not work this worker can grade itself on.'
    );
  } else if (reason === 'not-verifiable') {
    // Bounded like every other branch. The runner caps its own capture, but a note that
    // depended on that would grow silently the day the capture limit is raised.
    lines.push(
      `The change could not be verified in this repository, so it was thrown away rather than offered. ${tail(test?.output.trim() ?? '', NOTE_OUTPUT_LIMIT)}`.trim(),
      '',
      'A change nothing can test is a change a reviewer would be the first check on, which is the one thing this worker is not allowed to do.'
    );
  } else {
    lines.push(`The run did not finish: ${summary}`);

    // An earlier attempt can have changed the code and failed the suite before the run fell
    // over. Both facts are worth having: one says what to fix, the other says why nobody got
    // round to it.
    if (test !== undefined) {
      lines.push(
        '',
        `An earlier attempt had changed the code, and \`${test.command ?? 'the test command'}\` reported:`,
        '',
        '{code}',
        tail(test.output.trim(), NOTE_OUTPUT_LIMIT),
        '{code}'
      );
    }
  }

  lines.push(
    '',
    "Nothing was pushed and no branch was created — that only happens after the repository's own tests pass. This counts as an attempt; the ticket is available again."
  );

  return lines.join('\n');
}

/**
 * One hand-off to the model, with a thrown error turned into an outcome.
 *
 * A transport failure is not exceptional here — it is just this attempt not working — and
 * letting it escape would leave the ticket claimed with nothing said on it. Contained so the
 * release path still runs.
 */
async function runAgent(request: AgentRunRequest, deps: ImplementDeps): Promise<AgentRun> {
  try {
    return await deps.agent.run(request);
  } catch (error) {
    deps.logger.error({ msg: 'agent run failed', key: request.task.key, err: error });

    return { outcome: 'gave-up', usage: NO_USAGE, summary: error instanceof Error ? error.message : String(error), deniedTools: [] };
  }
}

/** Everything a hand-back needs to know about the run that is being handed back. */
interface GiveUp {
  readonly reason: GiveUpReason;
  readonly attempts: number;
  readonly usage: TokenUsage;
  readonly test: TestRun | undefined;
  readonly summary: string;
}

/**
 * The one exit that touches Jira, shared by every way of not finishing.
 *
 * Every give-up goes through here so none of them can forget to comment, and so the
 * attempt-count bump that `ReleasePort.handBack` owes cannot be skipped by a path that returns
 * early — including the two that refuse before any model run at all.
 */
async function handBack(assignment: Assignment, gaveUp: GiveUp, deps: ImplementDeps): Promise<ImplementResult> {
  const { reason, attempts, usage } = gaveUp;
  const released = await deps.release.handBack(assignment.ticket, giveUpNote(reason, attempts, gaveUp.test, gaveUp.summary));

  if (!released.ok) {
    // Still held by the bot and still In Progress, on purpose — see `releaseTicket`. The boot
    // orphan sweep (MAPCO-11432) is what gets it back.
    deps.logger.error({ msg: 'gave up but could not release', key: assignment.ticket.key, reason, releaseReason: released.reason });
  }

  deps.logger.info({ msg: 'gave up', key: assignment.ticket.key, reason, attempts, released: released.ok, ...usage });

  return { ok: false, reason, attempts, usage, released: released.ok };
}

/** The ticket's prose, or the reason there is none: empty (`''`) or the read having failed. */
type Described = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly failed: string };

/**
 * The ticket's prose, or the reason there is none.
 *
 * A read that throws is contained rather than escaping: the ticket is claimed at this point, and
 * an exception here would leave it held with nothing said on it. Either way the answer is the
 * same shape and the caller hands the ticket back without paying for a model run.
 */
async function readDescription(assignment: Assignment, deps: ImplementDeps): Promise<Described> {
  try {
    const text = (await deps.description.read(assignment.ticket)).trim();

    return text === '' ? { ok: false, failed: '' } : { ok: true, text };
  } catch (error) {
    deps.logger.error({ msg: 'could not read the ticket description', key: assignment.ticket.key, err: error });

    return { ok: false, failed: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Implement one claimed ticket in one clone, and prove it with the repository's own tests.
 *
 * The shape of this is the point of the ticket: the model changes the code, the *worker* runs
 * the tests, and only a passing run counts as done. Nothing here talks to Jira, GitHub or git
 * — the change is left in the working tree for the push slice to deal with, and the only Jira
 * mutation this can cause is the hand-back on give-up, which goes through `ReleasePort`
 * (MAPCO-11431) rather than being written here.
 *
 * How the change is graded is settled before the model is handed anything: `tests.plan` reads
 * the test command off the clone as cloned, and every attempt is run against that plan. Doing
 * it in this order is what stops the model from editing the command that judges it — the model
 * has `Write` over the whole clone, package.json included, and re-reading the command after it
 * has run would make `"test": "echo ok"` the cheapest way to a green run.
 *
 * Two things are settled before the model is handed anything, and failing either is a refusal
 * rather than an attempt: a repository that states no test command, and a ticket that carries no
 * prose. The second is the easy one to get wrong — handing over a one-line summary buys a
 * hand-off whose only honest answer is "there is not enough here", at full price, on every
 * ticket in the queue.
 *
 * Three loop exits are deliberately not retried. `no-change` is not, because the input to the
 * next attempt would be identical — there is no failure to feed back, so the model would read
 * the same ticket and reach the same conclusion, twice as expensively. `not-verifiable` is
 * not, because a repository with no test command still has none a minute later.
 * `verification-changed` is not, because asking again is not an answer to it.
 */
async function implementTicket(assignment: Assignment, deps: ImplementDeps): Promise<ImplementResult> {
  const { ticket, workdir } = assignment;
  const { tests, logger, limits } = deps;

  let usage = NO_USAGE;
  let attempts = 0;
  let previousFailure: string | undefined;
  let lastTest: TestRun | undefined;
  let lastSummary = '';
  let reason: GiveUpReason = 'tests-failing';

  const planned = await tests.plan(workdir);

  if (!planned.ok) {
    // Refused before the model is paid for. Nothing about the change, everything about the
    // repository — and it would read the same way after three attempts as after none.
    logger.warn({ msg: 'repository states no test command', key: ticket.key, reason: planned.reason });

    const refusal: TestRun = { ok: false, reason: planned.reason, command: null, output: planned.output };

    return handBack(assignment, { reason: 'not-verifiable', attempts, usage, test: refusal, summary: '' }, deps);
  }

  const described = await readDescription(assignment, deps);

  if (!described.ok) {
    // The second refusal that happens before the model is paid for. A ticket with no prose is
    // one the model can only guess at, and a guess is what this worker exists not to offer —
    // asking it anyway costs a hand-off to be told what the ticket already said.
    logger.warn({ msg: 'ticket carries no description', key: ticket.key, reason: described.failed === '' ? 'empty' : described.failed });

    return handBack(assignment, { reason: 'no-description', attempts, usage, test: undefined, summary: described.failed }, deps);
  }

  const task: AgentTask = { key: ticket.key, summary: ticket.summary, description: described.text };

  while (attempts < limits.maxAttempts) {
    attempts += 1;

    const run = await runAgent({ task, workdir, maxTurns: limits.maxTurns, previousFailure }, deps);
    usage = addUsage(usage, run.usage);
    lastSummary = run.summary;

    // `deniedTools` is only ever noise when it is empty. A name in it means the model went
    // looking for something it was not given — worth seeing, and evidence the deny worked.
    logger.info({ msg: 'agent attempt done', key: ticket.key, attempt: attempts, outcome: run.outcome, denied: run.deniedTools, ...run.usage });

    if (run.outcome !== 'changed') {
      if (run.outcome === 'no-change' && lastTest !== undefined) {
        // An earlier attempt did change the tree, and its suite failed — the loop only reaches
        // here with a `lastTest` in hand if that happened. That failure is the truth about this
        // ticket and the diff is still in the working tree, so reporting this run's "nothing to
        // do" instead would put a note on the ticket saying it was too thin to act on while a
        // real change sat next to it and the failure that stopped the run went unquoted.
        reason = 'tests-failing';
      } else if (run.outcome === 'no-change') {
        reason = 'no-change';
      } else {
        // A run that fell over keeps its own reason — an API outage must not read as a failing
        // suite — but the note quotes both, because both happened.
        reason = 'agent-error';
      }

      break;
    }

    // The plan, not the manifest as it now stands. `tests.run` refuses if the two have parted
    // company; it does not quietly follow the new one.
    const test = await tests.run(workdir, planned.plan);
    lastTest = test;

    if (test.ok) {
      logger.info({ msg: 'change verified', key: ticket.key, attempt: attempts, command: test.command, ...usage });

      return { ok: true, attempts, usage, command: test.command };
    }

    logger.warn({ msg: 'tests did not pass', key: ticket.key, attempt: attempts, reason: test.reason, command: test.command });

    if (test.reason !== 'failed') {
      // A rewritten test script is reported as itself rather than folded into "not verifiable".
      // The first is a person's problem and the second is a repository's, and a note that
      // conflated them would hide the interesting one.
      reason = test.reason === 'verification-changed' ? 'verification-changed' : 'not-verifiable';
      break;
    }

    previousFailure = buildFailureReport(test.command, test.output);
  }

  return handBack(assignment, { reason, attempts, usage, test: lastTest, summary: lastSummary }, deps);
}

export { DEFAULT_AGENT_LIMITS, giveUpNote, implementTicket };
export type { GiveUp, GiveUpReason, ImplementDeps, ImplementResult };
