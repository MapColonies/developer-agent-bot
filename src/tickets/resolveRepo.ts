import type { GitHubPort, Repo } from '../github/types';
import type { JiraTicket } from '../jira/types';

/**
 * Why a ticket could not be turned into a repo. A refusal is a first-class outcome, not an
 * error: the worker comments what it looked for, releases the ticket and bumps the attempt
 * count. Refusing well is most of this step's job (MAPCO-11433).
 */
type RefusalReason = 'no-prefix' | 'unknown-repo';

type RepoResolution =
  { readonly ok: true; readonly repo: Repo } | { readonly ok: false; readonly reason: RefusalReason; readonly looked: string | null };

/**
 * GitHub repo names allow letters, digits, dot, dash and underscore. Anything else in the
 * prefix means the colon was punctuation in a sentence rather than the title convention.
 */
const REPO_NAME = /^[A-Za-z0-9._-]+$/u;
const NOT_PRESENT = -1;

/**
 * The repo name a ticket is about, from the `<repo-name>: <feature title>` convention.
 *
 * Splits on the *first* colon only, so a feature title may contain colons of its own.
 * Returns null when the title does not follow the convention at all — which is the common
 * case for tickets written before it existed, and must read as a refusal rather than a guess.
 */
function parseRepoPrefix(summary: string): string | null {
  const colon = summary.indexOf(':');
  if (colon === NOT_PRESENT) {
    return null;
  }

  const prefix = summary.slice(0, colon).trim();

  return REPO_NAME.test(prefix) ? prefix : null;
}

/**
 * Resolve the repo a ticket is about.
 *
 * The name GitHub returns wins over the one in the title. GitHub matches case-insensitively,
 * so `LLM-Configuration` and `llm-configuration` both find the repo — but only its canonical
 * spelling is safe to clone with or build a branch name from.
 */
async function resolveRepo(ticket: JiraTicket, github: GitHubPort): Promise<RepoResolution> {
  const prefix = parseRepoPrefix(ticket.summary);

  if (prefix === null) {
    return { ok: false, reason: 'no-prefix', looked: null };
  }

  const repo = await github.findRepo(prefix);

  if (repo === null) {
    return { ok: false, reason: 'unknown-repo', looked: prefix };
  }

  return { ok: true, repo };
}

/** What the worker says on the ticket when it refuses. Names what it looked for. */
function describeRefusal(resolution: Extract<RepoResolution, { ok: false }>): string {
  if (resolution.reason === 'no-prefix') {
    return 'Could not tell which repository this ticket is about. Titles must start with `<repo-name>: `, for example `raster-shared: add a retry to the fetch helper`.';
  }

  return `Could not find a repository named \`${resolution.looked ?? ''}\` in the MapColonies organisation. The part of the title before the first colon must be a real repository name.`;
}

export { describeRefusal, parseRepoPrefix, resolveRepo };
export type { RefusalReason, RepoResolution };
