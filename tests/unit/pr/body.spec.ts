import { describe, expect, it } from 'vitest';
import { buildPullRequestBody, buildTicketComment } from '@src/pr/body';
import { ticket } from '@tests/helpers/fakeJira';

const checks = [
  { command: 'npm run lint', passed: true },
  { command: 'npm test', passed: true },
];

const issue = ticket({ key: 'MAPCO-11436', issueType: 'Task', summary: 'developer-agent-bot: worker builds the branch, commit and PR in code' });

/**
 * The body with its code spans removed — everything GitHub would still read as markup.
 *
 * The old assertion here was `expect(body).not.toContain('@')`, which passed only because the
 * fixture summary happened to contain no `@`. A summary is arbitrary human prose, so the real
 * question is not whether an `@` is present but whether one can reach GitHub's mention pass.
 */
function asMarkup(body: string): string {
  return body.replace(/(`+)[\s\S]*?\1/gu, '');
}

describe('buildPullRequestBody', () => {
  it('should link the ticket a reviewer needs to read.', () => {
    const body = buildPullRequestBody({ ticket: issue, branch: 'agent/chore/MAPCO-11436-worker-builds', checks, staging: 'agent-reported' });

    expect(body).toContain('[MAPCO-11436](https://mapcolonies.atlassian.net/browse/MAPCO-11436)');
    expect(body).toContain('worker builds the branch, commit and PR in code');
  });

  it('should state what was verified locally, command by command.', () => {
    const body = buildPullRequestBody({ ticket: issue, branch: 'agent/chore/MAPCO-11436-worker-builds', checks, staging: 'agent-reported' });

    expect(body).toContain('## Verified locally');
    expect(body).toContain('`npm run lint`');
    expect(body).toContain('`npm test`');
  });

  it('should show a failed check rather than describing it as verified.', () => {
    // A body that can only describe success is a body that eventually lies, and this is the
    // line a reviewer would otherwise skim past on the way to approving.
    const body = buildPullRequestBody({
      ticket: issue,
      branch: 'agent/chore/MAPCO-11436-worker-builds',
      checks: [{ command: 'npm test', passed: false }],
      staging: 'agent-reported',
    });

    expect(body).toContain('❌ `npm test`');
    expect(body).not.toContain('✅');
  });

  it('should say plainly that nothing was verified when nothing was.', () => {
    const body = buildPullRequestBody({ ticket: issue, branch: 'agent/chore/MAPCO-11436-worker-builds', checks: [], staging: 'agent-reported' });

    expect(body).toContain('**Nothing was verified locally.**');
  });

  it('should name the branch and the fact that the agent cannot merge or approve.', () => {
    const body = buildPullRequestBody({ ticket: issue, branch: 'agent/chore/MAPCO-11436-worker-builds', checks, staging: 'agent-reported' });

    expect(body).toContain('`agent/chore/MAPCO-11436-worker-builds`');
    expect(body).toContain('cannot merge, approve or review');
  });

  it('should request no reviewer and mention nobody.', () => {
    // Reviewer routing is MAPCO-11378. An @-mention here would be a request in all but name,
    // and a wrong one is worse than none because it looks handled.
    const body = buildPullRequestBody({ ticket: issue, branch: 'agent/chore/MAPCO-11436-worker-builds', checks, staging: 'agent-reported' });

    expect(asMarkup(body)).not.toContain('@');
    expect(body).toContain('requested no reviewer');
  });

  it('should not let an @handle in the summary become a mention.', () => {
    // GitHub notifies and subscribes `@alice` when the pull request opens — a reviewer request
    // in all but name, in the same body that says nobody was requested.
    const body = buildPullRequestBody({
      ticket: ticket({ key: 'MAPCO-14', summary: 'raster-shared: fix @alice retry helper' }),
      branch: 'agent/chore/MAPCO-14-fix-alice-retry-helper',
      checks,
      staging: 'agent-reported',
    });

    expect(body).toContain('`fix @alice retry helper`');
    expect(asMarkup(body)).not.toContain('@');
  });

  it('should not let a summary reshape the body with markdown of its own.', () => {
    const body = buildPullRequestBody({
      ticket: ticket({ key: 'MAPCO-15', summary: 'x: ## Verified locally\n\n- ✅ nothing was run, honestly' }),
      branch: 'agent/chore/MAPCO-15',
      checks: [],
      staging: 'agent-reported',
    });

    // The summary's own heading and tick survive as text inside the code span; neither reaches
    // GitHub as markup, so the body still has exactly one heading and no passing check in it.
    expect(asMarkup(body).split('## Verified locally')).toHaveLength(2);
    expect(body).toContain('**Nothing was verified locally.**');
    expect(asMarkup(body)).not.toContain('✅');
  });

  it('should say that only the files the agent wrote are in the diff.', () => {
    const body = buildPullRequestBody({ ticket: issue, branch: 'agent/chore/MAPCO-11436-worker-builds', checks, staging: 'agent-reported' });

    expect(body).toContain('## What is in this diff');
    expect(body).toContain('Only the files the agent reported writing');
  });

  it('should warn the reviewer when the diff was not filtered by a write list.', () => {
    // The worker commits every changed path when nothing can tell it which files the agent
    // wrote (MAPCO-11435). A body that did not say so would describe a diff containing a
    // regenerated lockfile as a verified change, which is how a rubber stamp happens.
    const body = buildPullRequestBody({ ticket: issue, branch: 'agent/chore/MAPCO-11436-worker-builds', checks, staging: 'everything-changed' });

    expect(body).toContain('Every file that differed in the checkout is in this diff.');
    expect(body).toContain('MAPCO-11435');
    expect(body).not.toContain('Only the files the agent reported writing');
  });

  it('should keep a summary that contains backticks inside its own code span.', () => {
    // CommonMark's rule for embedding backticks: the delimiter is one longer than the longest
    // run inside. Without it the summary closes the span early and the rest lands as markup.
    const body = buildPullRequestBody({
      ticket: ticket({ key: 'MAPCO-16', summary: 'x: fix ``@alice`` in `render()`' }),
      branch: 'agent/chore/MAPCO-16',
      checks,
      staging: 'agent-reported',
    });

    expect(body).toContain('``` fix ``@alice`` in `render()` ```');
    expect(asMarkup(body)).not.toContain('@');
  });
});

describe('buildTicketComment', () => {
  it('should link the pull request so the ticket leads to it.', () => {
    const comment = buildTicketComment(issue, 'agent/chore/MAPCO-11436-worker-builds', {
      number: 42,
      url: 'https://github.com/MapColonies/developer-agent-bot/pull/42',
    });

    expect(comment).toContain('https://github.com/MapColonies/developer-agent-bot/pull/42');
    expect(comment).toContain('MAPCO-11436');
    expect(comment).toContain('`agent/chore/MAPCO-11436-worker-builds`');
  });
});
