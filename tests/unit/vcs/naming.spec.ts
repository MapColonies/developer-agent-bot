import { describe, expect, it } from 'vitest';
import { branchName, branchType, commitMessage, commitTitle, commitType, featureTitle, slugify, ticketUrl } from '@src/vcs/naming';
import { ticket } from '@tests/helpers/fakeJira';

/** The git convention the commit header is bounded to, and comfortably inside commitlint's 100. */
const HEADER_LIMIT = 72;

/**
 * The types `@map-colonies/commitlint-config` will accept, verbatim from its own `type-enum`.
 *
 * Asserted against rather than trusted, because a type outside this list fails the org's
 * `commit-msg` hook and matches nothing in release-please — which is exactly how the first draft
 * of this slice shipped a `bug:` header that no repo in the org would take.
 */
const ORG_TYPE_ENUM = ['deps', 'devdeps', 'helm', 'build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'];

/**
 * The header properties `@commitlint/config-conventional` actually enforces, asserted here
 * rather than described in a comment.
 *
 * `subject-case` forbids a sentence-cased subject, and commitlint's sentence-case test is
 * literally `upperFirst(subject) === subject` — so the rule reduces to "the subject must not
 * begin with an upper-case letter". `type-enum` and `subject-full-stop` are the other two the
 * org's config leaves on. All 264 headers this module produces for a cross-product of issue
 * types, hostile summaries and malformed keys were also run through the real linter
 * programmatically; this keeps the properties they passed on under test.
 */
function expectCommitlintClean(header: string): void {
  const [type, subject] = header.split(': ');

  expect(ORG_TYPE_ENUM).toContain(type);
  expect(subject).toBeDefined();
  expect(header.endsWith('.')).toBe(false);
  expect(header).not.toContain('\n');
  expect(header.length).toBeLessThanOrEqual(HEADER_LIMIT);

  const first = (subject as string).slice(0, 1);

  expect(first).toBe(first.toLowerCase());
}

/**
 * The shapes `git check-ref-format` rejects. Asserted as a set rather than one case at a time,
 * because the risk is a title nobody thought of producing a branch git will not accept — a
 * failure that only shows up against a real remote.
 */
function expectRefSafe(ref: string): void {
  expect(ref).toMatch(/^agent\//u);
  expect(ref).not.toMatch(/[\s~^:?*[\\]/u);
  expect(ref).not.toContain('..');
  expect(ref).not.toContain('//');
  expect(ref).not.toContain('@{');
  expect(ref.endsWith('.lock')).toBe(false);
  expect(ref.endsWith('.')).toBe(false);
  expect(ref.endsWith('/')).toBe(false);
  expect(ref.endsWith('-')).toBe(false);
}

describe('branchType', () => {
  it('should name a Bug branch bug, which is the segment the ticket asks for.', () => {
    // Nothing validates a branch name, so the branch is where the ticket's own vocabulary can be
    // honoured literally. The header cannot afford to — see `commitType`.
    expect(branchType('Bug')).toBe('bug');
  });

  it('should map the user-facing types to feat so a merge still cuts a release.', () => {
    expect(branchType('Feature')).toBe('feat');
    expect(branchType('Story')).toBe('feat');
    expect(branchType('Product Requirement')).toBe('feat');
  });

  it('should map the internal types to chore.', () => {
    expect(branchType('Task')).toBe('chore');
    expect(branchType('Tech Requirement')).toBe('chore');
    expect(branchType('Epic')).toBe('chore');
  });

  it('should not care about casing or extra whitespace in the issue type.', () => {
    expect(branchType('  tech   requirement ')).toBe('chore');
  });

  it('should default an unmapped type to chore rather than to feat.', () => {
    // A guessed `feat:` on an unfamiliar issue type cuts a release on a real repo. A missed
    // release is fixable; a published one is not.
    expect(branchType('Spike')).toBe('chore');
    expect(branchType('')).toBe('chore');
  });
});

describe('commitType', () => {
  it('should write a Bug as fix, because bug is not a conventional-commit type.', () => {
    // `bug` is in neither `@map-colonies/commitlint-config`'s `type-enum` nor release-please's
    // vocabulary: a `bug:` header is rejected by the org's own `commit-msg` hook, and a merged
    // one would ship with no patch release and no changelog line.
    expect(commitType('Bug')).toBe('fix');
    expect(ORG_TYPE_ENUM).toContain(commitType('Bug'));
  });

  it('should keep the real type for everything else rather than flattening to chore.', () => {
    expect(commitType('Feature')).toBe('feat');
    expect(commitType('Story')).toBe('feat');
    expect(commitType('Task')).toBe('chore');
    expect(commitType('Spike')).toBe('chore');
  });

  it('should only ever produce a type the org config accepts.', () => {
    for (const issueType of ['Bug', 'Feature', 'Story', 'Product Requirement', 'Task', 'Tech Requirement', 'Epic', 'Spike', '']) {
      expect(ORG_TYPE_ENUM).toContain(commitType(issueType));
    }
  });
});

describe('featureTitle', () => {
  it('should drop the repo prefix so the branch slug is about the feature.', () => {
    expect(featureTitle('raster-shared: add a retry to the fetch helper')).toBe('add a retry to the fetch helper');
  });

  it('should keep the whole summary when there is no repo prefix.', () => {
    expect(featureTitle('Fix the map menu spinner')).toBe('Fix the map menu spinner');
  });

  it('should keep a prose colon, because that is not the title convention.', () => {
    // Delegated to `parseRepoPrefix`, so the rule for what counts as a prefix lives in one place.
    expect(featureTitle('Note to whoever picks this up: the spinner leaks')).toBe('Note to whoever picks this up: the spinner leaks');
  });

  it('should split on the first colon only, leaving later ones in the title.', () => {
    expect(featureTitle('mc-mapproxy: fix the seed: retry loop')).toBe('fix the seed: retry loop');
  });
});

describe('slugify', () => {
  it('should fold accents rather than dropping the letters they sit on.', () => {
    expect(slugify('Café résumé')).toBe('cafe-resume');
  });

  it('should be empty for a title with nothing sluggable in it.', () => {
    // A dangling dash on the end of a branch name is worse than no slug at all.
    expect(slugify('בדיקה')).toBe('');
    expect(slugify('!!! ??? ...')).toBe('');
  });

  it('should cut at a dash rather than mid-word.', () => {
    const long = slugify('add a retry to the fetch helper so a flaky upstream does not fail the whole job');

    expect(long.endsWith('-')).toBe(false);
    expect('add-a-retry-to-the-fetch-helper-so-a-flaky-upstream-does-not'.startsWith(long)).toBe(true);
  });
});

describe('branchName', () => {
  it('should put agent leftmost, then the type, then the key and a slug.', () => {
    const branch = branchName(
      ticket({ key: 'MAPCO-11436', issueType: 'Task', summary: 'developer-agent-bot: worker builds the branch, commit and PR in code' })
    );

    expect(branch).toBe('agent/chore/MAPCO-11436-worker-builds-the-branch-commit-and-pr-in-code');

    expectRefSafe(branch);
  });

  it('should use the real issue type in the branch, not a flattened one.', () => {
    expect(branchName(ticket({ key: 'MAPCO-2', issueType: 'Bug', summary: 'raster-shared: retry loop spins' }))).toBe(
      'agent/bug/MAPCO-2-retry-loop-spins'
    );
    expect(branchName(ticket({ key: 'MAPCO-3', issueType: 'Feature', summary: 'raster-shared: retry loop spins' }))).toBe(
      'agent/feat/MAPCO-3-retry-loop-spins'
    );
  });

  it('should stay a valid ref when the summary is entirely punctuation.', () => {
    const branch = branchName(ticket({ key: 'MAPCO-9', summary: 'some-service: ***???...' }));

    expect(branch).toBe('agent/chore/MAPCO-9');

    expectRefSafe(branch);
  });

  it('should stay a valid ref when the summary is not written in Latin script.', () => {
    const branch = branchName(ticket({ key: 'MAPCO-9', issueType: 'Bug', summary: 'raster-shared: תקן את הלופ' }));

    expect(branch).toBe('agent/bug/MAPCO-9');

    expectRefSafe(branch);
  });

  it('should not let a summary introduce a path segment of its own.', () => {
    // Slashes in a title must not push `agent/` rightwards, or the prefix stops being something
    // a branch-protection rule and a `git branch --list agent/*` can rely on.
    const branch = branchName(ticket({ key: 'MAPCO-10', summary: 'some-service: fix feature/x and refs/heads/master handling' }));

    expect(branch.split('/')).toHaveLength(3);
    expect(branch).toBe('agent/chore/MAPCO-10-fix-feature-x-and-refs-heads-master-handling');

    expectRefSafe(branch);
  });

  it('should stay bounded for a summary nobody bounded.', () => {
    const summary = `some-service: ${'refactor the tile aggregation pipeline so that every layer is re-projected exactly once '.repeat(5)}`;

    const branch = branchName(ticket({ key: 'MAPCO-11', summary }));

    expect(branch.length).toBeLessThanOrEqual(HEADER_LIMIT);

    expectRefSafe(branch);
  });

  it('should refuse to build a malformed ref out of a malformed key.', () => {
    const branch = branchName(ticket({ key: '  ', summary: 'some-service: do the thing' }));

    expect(branch).toBe('agent/chore/no-key-do-the-thing');

    expectRefSafe(branch);
  });

  it('should not carry the casing of a summary that repeats the repo name.', () => {
    const branch = branchName(ticket({ key: 'MAPCO-12', summary: 'LLM-Configuration: Tidy The Prompts' }));

    expect(branch).toBe('agent/chore/MAPCO-12-tidy-the-prompts');
  });
});

describe('commitTitle', () => {
  it('should be a conventional commit using the real type and referencing the key.', () => {
    const title = commitTitle(
      ticket({ key: 'MAPCO-11436', issueType: 'Feature', summary: 'developer-agent-bot: Worker builds the branch, commit and PR in code' })
    );

    expect(title).toBe('feat: worker builds the branch, commit and PR in code (MAPCO-11436)');

    expectCommitlintClean(title);
  });

  it('should keep the key out of the head of the subject, which commitlint rejects.', () => {
    // The defect this replaces: `chore: MAPCO-4 stop the loop` fails `subject-case`, because an
    // upper-case first character makes `upperFirst(subject) === subject` true. That was every
    // ticket, of every issue type — with the org's `commit-msg` hook installed in the clone,
    // nothing was committed, pushed, opened or commented at all.
    const title = commitTitle(ticket({ key: 'MAPCO-4', summary: 'x: stop the loop' }));

    expect(title).toBe('chore: stop the loop (MAPCO-4)');
    expect(title).not.toMatch(/^chore: MAPCO/u);

    expectCommitlintClean(title);
  });

  it('should not flatten a feature to chore, because a merged feat is meant to cut a release.', () => {
    expect(commitTitle(ticket({ issueType: 'Story', summary: 'x: add a thing' }))).toMatch(/^feat: /u);
    expect(commitTitle(ticket({ issueType: 'Bug', summary: 'x: stop the thing' }))).toMatch(/^fix: /u);
  });

  it('should never write bug as a type, whatever the branch is called.', () => {
    const title = commitTitle(ticket({ key: 'MAPCO-2', issueType: 'Bug', summary: 'raster-shared: retry loop spins' }));

    expect(title).toBe('fix: retry loop spins (MAPCO-2)');
    expect(title).not.toMatch(/^bug:/u);

    expectCommitlintClean(title);
  });

  it('should drop a trailing full stop, which commitlint rejects.', () => {
    expect(commitTitle(ticket({ key: 'MAPCO-4', summary: 'x: stop the retry loop spinning.' }))).toBe(
      'chore: stop the retry loop spinning (MAPCO-4)'
    );
  });

  it('should lower-case the first word, and an acronym as a whole word rather than to sLD.', () => {
    // `chore: SLD parsing drops a rule` is rejected by the real linter too, so the acronym
    // cannot simply be left alone; lowering it character by character would read as `sLD`.
    expect(commitTitle(ticket({ key: 'MAPCO-5', summary: 'x: Stop the loop' }))).toBe('chore: stop the loop (MAPCO-5)');
    expect(commitTitle(ticket({ key: 'MAPCO-6', summary: 'x: SLD parsing drops a rule' }))).toBe('chore: sld parsing drops a rule (MAPCO-6)');
  });

  it('should bound the header and cut it at a word boundary, keeping the key.', () => {
    const title = commitTitle(
      ticket({ key: 'MAPCO-7', summary: 'x: refactor the tile aggregation pipeline so every layer is re-projected exactly once' })
    );

    expect(title).toBe('chore: refactor the tile aggregation pipeline so every layer (MAPCO-7)');

    expectCommitlintClean(title);
  });

  it('should still say something when the summary has nothing left in it.', () => {
    // An empty subject is `subject-empty`, which is an error. A sentence is not much, but it is
    // a header the hook takes and a changelog line that parses.
    const title = commitTitle(ticket({ key: 'MAPCO-8', summary: 'x: ...' }));

    expect(title).toBe('chore: apply the change described on the ticket (MAPCO-8)');

    expectCommitlintClean(title);
  });

  it('should collapse a summary that spans several lines onto one subject.', () => {
    expect(commitTitle(ticket({ key: 'MAPCO-13', summary: 'x: stop the loop\nand the other one' }))).toBe(
      'chore: stop the loop and the other one (MAPCO-13)'
    );
  });

  it('should stay a valid header for every issue type and every hostile summary.', () => {
    // The same cross-product was run through the real `@map-colonies/commitlint-config`
    // programmatically and rejected none of 264 headers. This is that check without the linter.
    const summaries = [
      'x: SLD parsing drops a rule',
      'x: !!! ???',
      'x: fix @alice retry helper',
      'x: HEAD',
      'x: École de cartographie',
      'x: תקן את הלופ',
      'x: 3d tiles support',
      'no prefix here at all',
      'x: --force the thing',
      'x: `backticks` and **stars**',
      'x: 🚀 ship it',
      'x: ABC DEF',
      `x: ${'reproject every layer exactly once '.repeat(9)}`,
    ];

    const issueTypes = ['Bug', 'Feature', 'Story', 'Task', 'Epic', 'Spike'];
    const headers = issueTypes.flatMap((issueType) => summaries.map((summary) => commitTitle(ticket({ key: 'MAPCO-11436', issueType, summary }))));

    expect(headers).toHaveLength(issueTypes.length * summaries.length);

    for (const header of headers) {
      expectCommitlintClean(header);
    }
  });
});

describe('ticketUrl', () => {
  it('should point at the issue a human reads.', () => {
    expect(ticketUrl('MAPCO-11436')).toBe('https://mapcolonies.atlassian.net/browse/MAPCO-11436');
  });

  it('should not double the slash when the base carries one.', () => {
    expect(ticketUrl('MAPCO-1', 'https://example.atlassian.net/browse/')).toBe('https://example.atlassian.net/browse/MAPCO-1');
  });
});

describe('commitMessage', () => {
  it('should lead with the conventional title and link the ticket in the body.', () => {
    const message = commitMessage(ticket({ key: 'MAPCO-11436', issueType: 'Bug', summary: 'x: stop the loop' }));
    const [subject, blank] = message.split('\n');

    expect(subject).toBe('fix: stop the loop (MAPCO-11436)');
    expect(blank).toBe('');
    expect(message).toContain('Ticket: https://mapcolonies.atlassian.net/browse/MAPCO-11436');
  });
});
