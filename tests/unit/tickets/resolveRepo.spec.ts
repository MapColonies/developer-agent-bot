import { describe, expect, it } from 'vitest';
import { describeRefusal, parseRepoPrefix, resolveRepo, type RepoResolution } from '@src/tickets/resolveRepo';
import type { GitHubPort, Repo } from '@src/github/types';
import { ticket } from '@tests/helpers/fakeJira';

const canonical: Repo = {
  name: 'LLM-configuration',
  fullName: 'MapColonies/LLM-configuration',
  defaultBranch: 'master',
  cloneUrl: 'https://github.com/MapColonies/LLM-configuration.git',
};

function fakeGitHub(repo: Repo | null): GitHubPort & { asked: string[] } {
  const asked: string[] = [];

  return {
    asked,
    findRepo: async (name: string): Promise<Repo | null> => {
      asked.push(name);

      return Promise.resolve(repo);
    },
  };
}

describe('parseRepoPrefix', () => {
  it('should take the part before the first colon.', () => {
    expect(parseRepoPrefix('raster-shared: add a retry')).toBe('raster-shared');
  });

  it('should split on the first colon only, so a feature title may contain its own.', () => {
    expect(parseRepoPrefix('mc-mapproxy: fix the seed: retry loop')).toBe('mc-mapproxy');
  });

  it('should return null when there is no prefix at all, which most existing tickets have.', () => {
    expect(parseRepoPrefix('Fix the map menu spinner')).toBeNull();
  });

  it('should not mistake sentence punctuation for the convention.', () => {
    // A prose colon leaves a prefix full of spaces, which is no repo name.
    expect(parseRepoPrefix('Note to whoever picks this up: the spinner leaks')).toBeNull();
  });

  it('should accept the characters GitHub allows in a repo name.', () => {
    expect(parseRepoPrefix('geo_package.merger-2: do the thing')).toBe('geo_package.merger-2');
  });
});

describe('resolveRepo', () => {
  it("should adopt GitHub's spelling over the one typed in the title.", async () => {
    // GitHub matches case-insensitively, so the lookup succeeds either way — but only the
    // canonical name is safe to clone with or build a branch name from.
    const github = fakeGitHub(canonical);

    const result = await resolveRepo(ticket({ summary: 'LLM-Configuration: this is a test ticket' }), github);

    expect(result).toStrictEqual<RepoResolution>({ ok: true, repo: canonical });
    expect(github.asked).toStrictEqual(['LLM-Configuration']);
  });

  it('should refuse a title with no prefix rather than guessing.', async () => {
    const github = fakeGitHub(canonical);

    const result = await resolveRepo(ticket({ summary: 'just do the thing' }), github);

    expect(result).toMatchObject({ ok: false, reason: 'no-prefix' });
    // It must not go looking, because it has nothing to look for.
    expect(github.asked).toStrictEqual([]);
  });

  it('should refuse a prefix that names no repo, and say what it looked for.', async () => {
    const github = fakeGitHub(null);

    const result = await resolveRepo(ticket({ summary: 'not-a-repo: do the thing' }), github);

    expect(result).toMatchObject({ ok: false, reason: 'unknown-repo', looked: 'not-a-repo' });
  });
});

describe('describeRefusal', () => {
  it('should name the repo it could not find.', () => {
    expect(describeRefusal({ ok: false, reason: 'unknown-repo', looked: 'not-a-repo' })).toContain('not-a-repo');
  });

  it('should show the expected title shape when there was no prefix.', () => {
    expect(describeRefusal({ ok: false, reason: 'no-prefix', looked: null })).toContain('<repo-name>: ');
  });
});
