import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@map-colonies/js-logger';
import type { Repo } from '../github/types';
import { CREDENTIAL_FROM_ENV, gitRunner, HOOKS_OFF, redact, TOKEN_ENV, type RunGit } from './gitInvoke';
import type { TokenProvider, Workspace, WorkspacePort } from './types';

/**
 * How long a clone may take before it is killed.
 *
 * Longer than the five minutes the publish path allows itself, because this one is a network
 * transfer of somebody else's repository over whatever the cluster's egress is having today. It
 * is bounded for the same reason everything else here is: `runCycle` awaits this, so a clone
 * that hangs stops the scheduler ticking and the queue silently stops behind a pod that no probe
 * will ever restart (MAPCO-11430).
 */
const CLONE_TIMEOUT_MS = 600_000;

/** Every workspace directory starts with this, so a stray one is recognisable on a volume. */
const WORKSPACE_PREFIX = 'agent-ticket-';

/**
 * The only host the worker will hand a push or clone credential to.
 *
 * Hard-coded to match `RestGitHub`'s org, and checked rather than trusted even though the URL
 * comes from GitHub's own API. The reason is specific to how the credential travels: the helper
 * in `CREDENTIAL_FROM_ENV` answers with the token for *whatever host git asks it about*, so a
 * remote nobody vetted is a live installation token handed to that remote. Checking the host
 * before minting means there is nothing to hand over.
 */
const GITHUB_HOST = 'github.com';

/**
 * Schemes the worker will clone from.
 *
 * `https:` is production, and only on `GITHUB_HOST`. `file:` is allowed and is deliberately
 * given **no credential**: a local path cannot be an exfiltration target, and it is how a dry run
 * can be pointed at a repository on disk and how `tests/unit/vcs/clone.spec.ts` exercises a real
 * `git clone` against a real bare repository rather than against a fake that agrees with it.
 * Everything else — `ssh:`, `git:`, a bare `host:path` scp-like remote — is refused: each one
 * reaches a different credential path, none of which this worker has thought about.
 */
const HTTPS = 'https:';
const FILE = 'file:';

/**
 * A remote the worker will not clone from, as opposed to a clone that went wrong.
 *
 * A throw and not a refusal value, and the same argument as `GitGuardError`: a caller offering a
 * remote outside the org is a bug in the caller, not a state the pipeline is expected to reach.
 * It still lands on the ticket, because `DeliveryPort.deliver` (src/deliver.ts) turns a failed
 * workspace into a hand-back rather than losing the ticket over it.
 */
class CloneRefusedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CloneRefusedError';
  }
}

interface CloneWorkspaceOptions {
  /**
   * Directory the per-ticket workspaces are made under.
   *
   * A mounted volume in the pod and `os.tmpdir()` on a laptop. It is never deleted — only the
   * per-ticket directories inside it are — because in the cluster it belongs to the Deployment.
   */
  readonly root?: string;
  /** Mints the clone credential. Called once per clone, never held. */
  readonly tokens: TokenProvider;
  readonly logger: Logger;
  /** Overridden in tests. */
  readonly run?: RunGit;
}

/**
 * Where the credential goes, if anywhere.
 *
 * Returned as a decision rather than taken as a flag so the two questions — may we clone this at
 * all, and may we authenticate to it — are answered in one place and cannot drift apart.
 */
function credentialFor(cloneUrl: string, repo: Repo): 'github' | 'none' {
  let parsed: URL;

  try {
    parsed = new URL(cloneUrl);
  } catch {
    throw new CloneRefusedError(`refusing to clone ${repo.fullName}: \`${cloneUrl}\` is not a URL`);
  }

  if (parsed.protocol === HTTPS && parsed.host === GITHUB_HOST) {
    return 'github';
  }

  if (parsed.protocol === FILE) {
    return 'none';
  }

  throw new CloneRefusedError(
    `refusing to clone ${repo.fullName} from \`${parsed.protocol}//${parsed.host}\`: the worker only clones ${HTTPS}//${GITHUB_HOST}, because the push credential would otherwise be offered to it`
  );
}

/**
 * The ephemeral clone MAPCO-11433 asks for: the repo at its default branch, in a directory of
 * its own, gone again afterwards.
 *
 * Three things are worth saying about the shape.
 *
 * **The branch is GitHub's `default_branch`, not the remote's HEAD.** The org has both `master`
 * and `main` repositories and the two are not interchangeable — `repo.defaultBranch` is what the
 * pull request is opened against, so the checkout has to be the same ref or the diff is against
 * the wrong base. Asking git to pick means a repository whose remote HEAD disagrees with the API
 * silently produces a pull request full of somebody else's commits.
 *
 * **Shallow and single-branch.** A ticket needs the tip, not the history: it is cheaper by orders
 * of magnitude on a large repository, and pushing a new branch from a depth-1 clone is what
 * `actions/checkout` does by default across the org, so it is not an exotic state for GitHub to
 * receive. `--no-tags` for the same reason — nothing here reads a tag.
 *
 * **The directory is made before git runs, so every failure has to clean up after itself.**
 * `create` removes it on the way out of a failed clone, and `dispose` removes it on the way out
 * of a finished ticket. A worker that leaked one directory per failed ticket would fill the
 * volume and then fail every ticket, which is the failure mode that looks like something else.
 */
class CloneWorkspace implements WorkspacePort {
  private readonly root: string;

  private readonly git: RunGit;

  public constructor(private readonly options: CloneWorkspaceOptions) {
    this.root = options.root ?? tmpdir();
    this.git = options.run ?? gitRunner(CLONE_TIMEOUT_MS);
  }

  public async create(repo: Repo): Promise<Workspace> {
    // Refused before the directory is made and before the token is minted: a remote the worker
    // will not clone from should cost nothing and leave nothing.
    const credential = credentialFor(repo.cloneUrl, repo);

    // Minted before the directory exists, so a credential this worker cannot produce leaves
    // nothing behind either: `mint` throws on a missing `GITHUB_TOKEN`, and between `mkdtemp`
    // and the `try` below there is no `catch` to remove what it had already made.
    const token = credential === 'github' ? await this.options.tokens.mint() : '';

    // `mkdtemp` is what makes two tickets unable to share a workspace — the name is chosen by
    // the kernel, not by us, so there is no ticket key to collide on and no clean-up race
    // between a retry and the attempt it is retrying.
    const dir = await mkdtemp(join(this.root, WORKSPACE_PREFIX));

    try {
      await this.git(
        [
          ...HOOKS_OFF,
          ...(credential === 'github' ? CREDENTIAL_FROM_ENV : []),
          'clone',
          '--depth',
          '1',
          '--single-branch',
          '--no-tags',
          '--branch',
          repo.defaultBranch,
          '--',
          repo.cloneUrl,
          dir,
        ],
        this.root,
        credential === 'github' ? { [TOKEN_ENV]: token } : {}
      );
    } catch (err) {
      await this.remove(dir);

      // git echoes the remote URL back on failure, credentials included.
      throw new Error(redact(err instanceof Error ? err.message : String(err), token));
    }

    this.options.logger.info({ msg: 'workspace cloned', repo: repo.fullName, branch: repo.defaultBranch, dir });

    return {
      dir,
      dispose: async (): Promise<void> => {
        await this.remove(dir);
      },
    };
  }

  /**
   * Remove a directory and never reject.
   *
   * `force: true` is what makes a second `dispose` a no-op rather than an `ENOENT`, and the
   * catch is what keeps a cleanup failure from replacing the ticket's real outcome — see
   * `Workspace.dispose`.
   */
  private async remove(dir: string): Promise<void> {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      this.options.logger.warn({ msg: 'could not remove the workspace', dir, err });
    }
  }
}

export { CloneRefusedError, CloneWorkspace, GITHUB_HOST };
export type { CloneWorkspaceOptions };
