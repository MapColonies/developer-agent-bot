import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * The first segment `path.relative` produces when the target sits outside the base.
 *
 * Compared as a whole segment rather than with `startsWith('..')`, because a file legitimately
 * named `..gitkeep` relativises to `..gitkeep` and is inside the checkout.
 */
const OUTSIDE = '..';

/**
 * Turn one path the agent slice reported writing into the path git prints, or refuse it.
 *
 * The two halves of the publish path do not speak the same dialect, and this is the seam where
 * that is dealt with rather than hoped about. `git status --porcelain` prints repo-relative
 * paths with forward slashes (`src/tiles.ts`); the model's `Edit` and `Write` tools report the
 * absolute path they were given (`/workspace/clone/src/tiles.ts`), because that is what the
 * Agent SDK's `file_path` argument is. Intersecting the two by string equality — which is what
 * this slice did first time round — silently matches nothing, and a publish path that stages
 * nothing opens no pull request and says only that the agent wrote nothing.
 *
 * `null` is a refusal, not an error: a path that resolves outside the checkout, or to the
 * checkout itself, is not something this worker will stage, and the caller names it in a log
 * line rather than throwing the ticket away over it.
 *
 * Symlinks are deliberately not resolved. `realpath` would turn a legitimate path inside a
 * symlinked checkout into one that appears to be outside it, and the guard that matters — no
 * `..`, no absolute pathspec, no `.git` — is applied to the result in `cliGit.ts` regardless.
 */
function toRepoRelative(candidate: string, root: string): string | null {
  if (candidate.trim() === '') {
    return null;
  }

  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  const inside = relative(resolve(root), absolute);

  // An empty result is the checkout root itself; an absolute one means the two paths share no
  // common root at all, which on POSIX only happens for a path that is not a path.
  if (inside === '' || isAbsolute(inside) || inside.split(sep)[0] === OUTSIDE) {
    return null;
  }

  // git speaks forward slashes whatever the platform, and the pathspecs handed back to it have
  // to match the strings it printed.
  return inside.split(sep).join('/');
}

export { toRepoRelative };
