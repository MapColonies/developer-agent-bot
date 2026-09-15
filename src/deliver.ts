import type { Logger } from '@map-colonies/js-logger';
import { implementTicket } from './agent/implement';
import { meterAgent } from './agent/meteredAgent';
import type { Implementer } from './agent/implementer';
import type { AgentPort } from './agent/types';
import type { TicketGuard } from './budget/guard';
import type { GitHubPort, Repo } from './github/types';
import type { JiraTicket } from './jira/types';
import { publishPullRequest, UNREPORTED_WRITES, type PublishRefusal } from './pr/publish';
import type { PullRequestPort, TicketCommentPort, VerifiedCheck } from './pr/types';
import type { HandBackOnce } from './tickets/handBackOnce';
import { describeRefusal, resolveRepo } from './tickets/resolveRepo';
import type { GitPort, Workspace, WorkspacePort } from './vcs/types';

/**
 * What happens to a claimed ticket, which until now was nothing.
 *
 * `runCycle` claimed a ticket and handed it straight back; separately, a fully tested
 * implement-and-verify core existed that nothing called. This is the sequence between the two:
 * work out which repository the ticket is about, clone it, hand the ticket to the model inside
 * that clone, run the repository's own tests, and — only on a passing run — commit, push and
 * open a pull request. Every step is somebody else's slice; what lives here is the order, the
 * refusals, and the guarantee that the clone goes away again.
 *
 * It is a port rather than inline code in `handleTicket` for the reason the rest of the worker is
 * built that way: `runCycle` is the seam the pipeline is tested through, and the claim/release
 * plumbing around this call has its own behaviour — concurrency caps, the poll's one-extra
 * ticket, a broken ticket not taking the run down — that is worth being able to exercise without
 * a whole pipeline standing behind it.
 *
 * Four things are refusals rather than errors, and each one hands the ticket back with an
 * attempt counted, because each is a thing a human has to read and decide about:
 *
 * - `no-repo` — the title names no repository, or names one that does not exist (MAPCO-11433).
 * - `no-workspace` — the repository could not be cloned. Often not the ticket's fault, which the
 *   note says; it is still counted, because the alternative is a ticket that is picked up and
 *   fails the same way on every tick.
 * - `not-implemented` — `implementTicket` gave up. It has already commented the specifics and
 *   handed the ticket back through the same latch this module holds; nothing more is written.
 * - `nothing-to-publish` — the suite passed over a working tree with nothing in it worth
 *   offering. An empty pull request is not a smaller result than a full one.
 */

/** Why a claimed ticket did not end in a pull request, when nothing actually broke. */
type DeliveryRefusal = 'no-repo' | 'no-workspace' | 'not-implemented' | 'nothing-to-publish';

type DeliveryOutcome =
  | { readonly ok: true; readonly branch: string; readonly url: string }
  | {
      readonly ok: false;
      readonly reason: DeliveryRefusal;
      /** Whether the ticket is back in Open. False means the worker still holds it. */
      readonly handedBack: boolean;
    };

interface DeliveryRequest {
  readonly ticket: JiraTicket;
  /**
   * This ticket's meter, which only a `cycle.start` that actually claimed it can hand out.
   *
   * Taken as an argument rather than opened here so a ticket cannot be worked without the day's
   * allowance having been checked and spent on it — the same structural argument the budget
   * guard makes one level up.
   */
  readonly meter: TicketGuard;
  /**
   * This ticket's at-most-once hand-back, created by `handleTicket` and shared with it.
   *
   * Passed in rather than made here so there is exactly **one** per ticket. Two objects each
   * claiming to be the ticket's latch would each allow a hand-back, which is the invariant they
   * exist to hold — and the caller needs the same one anyway, for the ticket it is still holding
   * when something throws out of here. See `createHandBackOnce`.
   */
  readonly handBack: HandBackOnce;
}

interface DeliveryPort {
  deliver: (request: DeliveryRequest) => Promise<DeliveryOutcome>;
}

interface DeliveryDeps {
  readonly github: GitHubPort;
  readonly workspaces: WorkspacePort;
  /** The implement step, already built. Supplies the per-ticket half per ticket. */
  readonly implementer: Implementer;
  readonly pullRequests: PullRequestPort;
  /** The pull-request link comment. `JiraPort` satisfies this structurally. */
  readonly tickets: TicketCommentPort;
  /** git inside one clone. A factory because the checkout does not exist until it is cloned. */
  readonly git: (options: { readonly cwd: string; readonly repo: Repo }) => GitPort;
  readonly logger: Logger;
}

/**
 * What the worker says on a ticket whose repository it could not clone.
 *
 * Says plainly that this may not be the ticket's fault, because the attempt is counted either
 * way and a reader who assumes the ticket is wrong will go looking in the wrong place. Two
 * failures in a row retire the ticket from the queue (`ATTEMPT_CAP`), so the note has to be
 * enough for somebody to decide whether to clear the counter and try again.
 */
function cloneFailedNote(repo: Repo, error: unknown): string {
  return [
    'Picked this up automatically and could not start work on it.',
    '',
    `\`${repo.fullName}\` could not be cloned at its default branch (\`${repo.defaultBranch}\`):`,
    '',
    '{code}',
    error instanceof Error ? error.message : String(error),
    '{code}',
    '',
    'This may be the repository or the network rather than the ticket — a private repository the worker has no access to looks like this, and so does a bad five minutes on the way out of the cluster. Nothing was changed and nothing was pushed. This counts as an attempt; the ticket is available again.',
  ].join('\n');
}

/** What the worker says when the suite passed but there is nothing worth offering a reviewer. */
function unpublishableNote(reason: PublishRefusal): string {
  const middle =
    reason === 'nothing-to-commit'
      ? 'The tests passed, but the working tree was identical to the branch they ran against — so there is no change to offer. Most often that means the model wrote a file back exactly as it found it.'
      : 'The tests passed, but the only files that differed were ones the model never reported writing — build output or a regenerated lockfile, most likely. A pull request whose whole diff is generated is worse than no pull request.';

  return [
    'Picked this up automatically and did not open a pull request.',
    '',
    middle,
    '',
    'Nothing was pushed and no branch was created. This counts as an attempt; the ticket is available again.',
  ].join('\n');
}

/** What the pull-request body says was checked, from what the verify step actually ran. */
function verifiedBy(command: string): readonly VerifiedCheck[] {
  // `passed: true` is not an assumption: `implementTicket` only reports success on a test run
  // that returned ok, against a command read off the clone *before* the model touched it.
  return [{ command, passed: true }];
}

function createDelivery(deps: DeliveryDeps): DeliveryPort {
  const { github, workspaces, implementer, pullRequests, tickets, logger } = deps;

  /** Clone, implement, publish. Separate so the workspace's `finally` has one thing to wrap. */
  const inWorkspace = async (repo: Repo, workspace: Workspace, request: DeliveryRequest): Promise<DeliveryOutcome> => {
    const { ticket, handBack } = request;
    const meter = (agent: AgentPort): AgentPort => meterAgent({ agent, meter: request.meter, handBack, logger });
    const implemented = await implementTicket({ ticket, workdir: workspace.dir }, implementer({ release: handBack, meter }));

    if (!implemented.ok) {
      // Already commented and handed back by `implementTicket`'s single give-up exit — through
      // the same latch, so an overspend that also ended the run wrote one comment, not two.
      return { ok: false, reason: 'not-implemented', handedBack: implemented.released };
    }

    const published = await publishPullRequest(
      { ticket, repo, checks: verifiedBy(implemented.command), wrote: UNREPORTED_WRITES },
      { git: deps.git({ cwd: workspace.dir, repo }), pullRequests, tickets, logger }
    );

    if (!published.ok) {
      const released = await handBack.handBack(ticket, unpublishableNote(published.reason));

      return { ok: false, reason: 'nothing-to-publish', handedBack: released.ok };
    }

    return { ok: true, branch: published.branch, url: published.pullRequest.url };
  };

  return {
    deliver: async (request: DeliveryRequest): Promise<DeliveryOutcome> => {
      const { ticket, handBack } = request;

      const resolution = await resolveRepo(ticket, github);

      if (!resolution.ok) {
        // The common path until the title convention spreads, and a refusal rather than a guess:
        // the note names what was looked for so a human can fix the title.
        logger.warn({ msg: 'refusing the ticket', key: ticket.key, reason: resolution.reason, looked: resolution.looked });
        const released = await handBack.handBack(ticket, describeRefusal(resolution));

        return { ok: false, reason: 'no-repo', handedBack: released.ok };
      }

      const { repo } = resolution;
      logger.info({ msg: 'repo resolved', key: ticket.key, repo: repo.fullName, base: repo.defaultBranch });

      let workspace: Workspace;
      try {
        workspace = await workspaces.create(repo);
      } catch (err) {
        logger.error({ msg: 'could not clone the repository', key: ticket.key, repo: repo.fullName, err });
        const released = await handBack.handBack(ticket, cloneFailedNote(repo, err));

        return { ok: false, reason: 'no-workspace', handedBack: released.ok };
      }

      try {
        return await inWorkspace(repo, workspace, request);
      } finally {
        // MAPCO-11433's "cleaned up on every path", and it is the `finally` that makes it true:
        // a publish failure throws by design, and a worker that leaked one clone per thrown
        // ticket would fill the volume and then fail every ticket for an unrelated-looking reason.
        await workspace.dispose();
      }
    },
  };
}

export { cloneFailedNote, createDelivery, unpublishableNote };
export type { DeliveryDeps, DeliveryOutcome, DeliveryPort, DeliveryRefusal, DeliveryRequest };
