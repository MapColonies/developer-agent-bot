import type { JiraTicket } from '../jira/types';
import { parseRepoPrefix } from '../tickets/resolveRepo';

/**
 * The `{type}` segment of a branch name.
 *
 * `bug` is what MAPCO-11436 asks for — "`{type}` being feat, bug or chore" — and a branch
 * segment is the one place it can be honoured, because nothing validates a branch name. It is
 * deliberately *not* what the commit header uses; see `CommitType`.
 */
type BranchType = 'feat' | 'bug' | 'chore';

/**
 * The conventional-commit type of the commit and pull-request header.
 *
 * `fix` and not `bug`, and this is the one place the ticket's wording is not followed literally.
 * `bug` is not a conventional-commit type: it is absent from `@map-colonies/commitlint-config`'s
 * `type-enum` (`deps, devdeps, helm, build, chore, ci, docs, feat, fix, perf, refactor, revert,
 * style, test`), so the org's own `commit-msg` hook rejects a `bug:` header outright, and
 * release-please matches no type for it — a merged agent bugfix would ship with no patch release
 * and no changelog line. `fix:` is the convention's type for a defect, is in the enum, and cuts
 * the patch release the ticket wants the real type to reach release-please for. The ticket's own
 * sentence separates the two ideas: the branch enumerates feat/bug/chore, and the header is
 * "conventional commits using the real type".
 */
type CommitType = 'feat' | 'fix' | 'chore';

/**
 * Jira issue type to branch type.
 *
 * Deliberately not flattened to `chore` for everything. Around 109 MapColonies repos run
 * release-please, so a merged `feat:` cuts a minor release — and an agent-authored feature is
 * a feature. Hiding that behind `chore:` would mean the changelog stops describing the
 * software, which is a worse outcome than an extra release.
 *
 * Keys are lower-cased issue-type names as the MAPCO project spells them.
 */
const BRANCH_TYPES: Record<string, BranchType> = {
  bug: 'bug',
  feature: 'feat',
  story: 'feat',
  'product requirement': 'feat',
  task: 'chore',
  'tech requirement': 'chore',
  epic: 'chore',
};

/** Branch type to the conventional-commit type that names the same thing in a header. */
const COMMIT_TYPES: Record<BranchType, CommitType> = { feat: 'feat', bug: 'fix', chore: 'chore' };

/**
 * What an issue type the map does not know becomes.
 *
 * `chore` and not `feat`, because the failure has to be the harmless one: guessing `feat` on
 * a type nobody has classified yet would cut a release on 109 repos' worth of unfamiliar
 * workflows. A missed release is noticed and fixed; a spurious one is already published.
 */
const DEFAULT_TYPE: BranchType = 'chore';

/** The leftmost path segment of every branch the worker creates. */
const AGENT_PREFIX = 'agent';

/**
 * How much of the ticket title survives into the branch name.
 *
 * A branch name is read in `git branch`, in a PR list and in a protection rule, none of which
 * are improved by the whole title. The key is what identifies the branch; the slug is only
 * there to make it recognisable.
 */
const SLUG_MAX_LENGTH = 48;

/**
 * How long a commit subject line may be.
 *
 * 72 is the git convention for a readable `git log --oneline`, and comfortably inside
 * commitlint's default `header-max-length` of 100 — a commit the target repo's own hook
 * rejects is a pull request that never happens.
 */
const HEADER_MAX_LENGTH = 72;

/** Stands in for a ticket key that sanitises away to nothing, so a ref is never malformed. */
const UNKNOWN_KEY = 'no-key';

/** What a subject says when the summary has nothing left in it once the repo prefix is off. */
const FALLBACK_SUBJECT = 'apply the change described on the ticket';

/**
 * Slug characters are allow-listed rather than blocked.
 *
 * `git check-ref-format` forbids a long list — spaces, `~`, `^`, `:`, `?`, `*`, `[`, `\`,
 * `..`, a trailing dot, a trailing `.lock`, consecutive or leading or trailing slashes, `@{`.
 * Enumerating that list invites missing one of them. Keeping only `[a-z0-9]` and joining with
 * single dashes makes every one of those shapes unrepresentable, including the ones added to
 * git after this was written. It is also why a title's own slashes cannot introduce a new path
 * segment, so `agent/` stays leftmost and stays greppable.
 */
const UNSAFE_SLUG_CHARS = /[^a-z0-9]+/gu;
const UNSAFE_KEY_CHARS = /[^A-Z0-9-]+/gu;
const EDGE_DASHES = /^-+|-+$/gu;
/** Combining marks left behind by NFKD, so `café` slugs as `cafe` rather than `caf`. */
const COMBINING_MARKS = /\p{M}+/gu;
const WHITESPACE = /\s+/gu;
/** Trailing punctuation on a subject, including the full stop commitlint's `subject-full-stop` bans. */
const TRAILING_PUNCTUATION = /[\s.,;:!?-]+$/u;
/** A leading word with no lower-case letter in it, so an acronym is lowered as a word and not to `sLD`. */
const ALL_CAPS_WORD = /^[^a-z]*[A-Z][^a-z]*$/u;

/** Where a MAPCO issue is read by a human. Same host the README links to. */
const JIRA_BROWSE_BASE = 'https://mapcolonies.atlassian.net/browse';

/**
 * The feature title, with the `<repo-name>: ` prefix taken off when there is one.
 *
 * Whether a colon is the title convention or just punctuation in a sentence is decided by
 * `parseRepoPrefix`, not decided again here — one rule, one place (MAPCO-11433 owns it). Only
 * the split is repeated, and only on the same first colon that rule looked at.
 */
function featureTitle(summary: string): string {
  const prefix = parseRepoPrefix(summary);

  if (prefix === null) {
    return summary.trim();
  }

  return summary.slice(summary.indexOf(':') + 1).trim();
}

/** The branch `{type}` segment for a Jira issue type. Unknown types get `DEFAULT_TYPE`. */
function branchType(issueType: string): BranchType {
  const normalised = issueType.trim().toLowerCase().replace(WHITESPACE, ' ');

  return BRANCH_TYPES[normalised] ?? DEFAULT_TYPE;
}

/** The conventional-commit type for a Jira issue type, which is what a header and a squash merge see. */
function commitType(issueType: string): CommitType {
  return COMMIT_TYPES[branchType(issueType)];
}

/** Cut a dash-joined slug to `limit`, at a dash rather than mid-word. */
function trimToWord(slug: string, limit: number): string {
  if (slug.length <= limit) {
    return slug;
  }

  const cut = slug.slice(0, limit);
  const lastDash = cut.lastIndexOf('-');

  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(EDGE_DASHES, '');
}

/**
 * A ref-safe, bounded slug for a title. May legitimately be empty — a title that is entirely
 * punctuation or entirely non-Latin script has no slug, and that is a branch without one
 * rather than a branch with a dangling dash.
 */
function slugify(title: string): string {
  const folded = title.normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase();

  return trimToWord(folded.replace(UNSAFE_SLUG_CHARS, '-').replace(EDGE_DASHES, ''), SLUG_MAX_LENGTH);
}

/** The issue key as it may appear in a ref: upper case, nothing exotic, never empty. */
function safeKey(key: string): string {
  const cleaned = key.trim().toUpperCase().replace(UNSAFE_KEY_CHARS, '-').replace(EDGE_DASHES, '');

  return cleaned === '' ? UNKNOWN_KEY : cleaned;
}

/**
 * The branch the worker pushes: `agent/{type}/MAPCO-XXXXX-short-slug`.
 *
 * `agent/` is the leftmost segment on purpose. It makes every machine-authored branch
 * greppable with one prefix, and it is the thing a branch-protection rule can be written
 * against later — which is the same reason `CliGit` refuses to push anything that does not
 * start with it.
 */
function branchName(ticket: JiraTicket): string {
  const slug = slugify(featureTitle(ticket.summary));
  const stem = `${AGENT_PREFIX}/${branchType(ticket.issueType)}/${safeKey(ticket.key)}`;

  return slug === '' ? stem : `${stem}-${slug}`;
}

/**
 * The subject half of a commit title: one line, no trailing full stop, first word lower-cased.
 *
 * The lower-casing is not house style, it is a hard requirement of the org's `commit-msg` hook.
 * `@commitlint/config-conventional`'s `subject-case` rule forbids a sentence-cased subject, and
 * its sentence-case test is literally `upperFirst(subject) === subject` — so a subject is
 * rejected whenever its *first character* is an upper-case letter, whatever follows. Verified
 * against the real linter: `chore: Stop the loop` and `chore: SLD parsing drops a rule` both
 * exit 1 on `subject-case`, and the lower-cased forms both exit 0.
 *
 * An all-capitals first word is lowered as a whole word rather than character by character, so
 * `SLD parsing` becomes `sld parsing` instead of the unreadable `sLD parsing`.
 */
function subjectFrom(title: string): string {
  const flat = title.replace(WHITESPACE, ' ').trim().replace(TRAILING_PUNCTUATION, '');
  const [first] = flat.split(' ');

  if (first === undefined || first === '') {
    return flat;
  }

  const lowered = ALL_CAPS_WORD.test(first) ? first.toLowerCase() : `${first.slice(0, 1).toLowerCase()}${first.slice(1)}`;

  return `${lowered}${flat.slice(first.length)}`;
}

/** Cut a subject to `limit` at a word boundary, leaving no trailing punctuation behind. */
function trimSubject(subject: string, limit: number): string {
  if (subject.length <= limit) {
    return subject;
  }

  const cut = subject.slice(0, Math.max(limit, 0));
  const lastSpace = cut.lastIndexOf(' ');

  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(TRAILING_PUNCTUATION, '');
}

/** Where a human reads the ticket. */
function ticketUrl(key: string, browseBase: string = JIRA_BROWSE_BASE): string {
  return `${browseBase.replace(/\/+$/u, '')}/${safeKey(key)}`;
}

/**
 * The conventional-commit title for a ticket: `{type}: {subject} (MAPCO-XXXXX)`.
 *
 * The key is a trailing reference rather than the head of the subject or a `(scope)`, and both
 * of those positions were tried against the real linter first:
 *
 * - `chore: MAPCO-4 stop the loop` is **rejected**. commitlint's sentence-case test is
 *   `upperFirst(subject) === subject`, and an upper-case `M` at the head of the subject makes
 *   that true, so `subject-case` fails on every ticket regardless of issue type. This is the
 *   defect MAPCO-11436 shipped with first time round.
 * - a `(scope)` is the one part of a header a target repo can reject outright: a `scope-enum` in
 *   somebody's commitlint config fails the hook on a key it has never heard of, and this string
 *   has to survive across every repo in the org.
 *
 * `chore: stop the loop (MAPCO-4)` exits 0 against `@map-colonies/commitlint-config`, keeps the
 * key greppable, and keeps it in the changelog line release-please generates. The pull request
 * gets this exact string too — a squash merge uses the PR title as the commit subject on the
 * default branch, so the two agreeing is what makes the type reach release-please at all.
 */
function commitTitle(ticket: JiraTicket): string {
  const type = commitType(ticket.issueType);
  const reference = `(${safeKey(ticket.key)})`;
  const described = subjectFrom(featureTitle(ticket.summary));
  // One space between the type and the subject, one before the reference.
  const room = HEADER_MAX_LENGTH - `${type}: `.length - reference.length - 1;
  const subject = trimSubject(described === '' ? FALLBACK_SUBJECT : described, room);

  // An absurdly long key can leave no room for a subject at all. A header that is only the
  // reference is still a valid conventional commit — commitlint's `subject-case` skips a
  // subject that does not start with a letter — and it is still bounded.
  return subject === '' ? `${type}: ${reference}` : `${type}: ${subject} ${reference}`;
}

/**
 * The full commit message: the conventional title, then a body that says where it came from.
 *
 * A reviewer arriving at a commit on a branch nobody recognises should not have to guess which
 * ticket it belongs to, and the pull request that links it may not exist yet at commit time.
 */
function commitMessage(ticket: JiraTicket): string {
  return [commitTitle(ticket), '', 'Written automatically by the MapColonies developer agent.', '', `Ticket: ${ticketUrl(ticket.key)}`].join('\n');
}

export { AGENT_PREFIX, branchName, branchType, commitMessage, commitTitle, commitType, featureTitle, slugify, ticketUrl };
export type { BranchType, CommitType };
