import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '@src/github/types';
import { RestPullRequests } from '@src/pr/restPullRequests';
import type { PullRequestDraft } from '@src/pr/types';
import type { TokenProvider } from '@src/vcs/types';

const CREATED = 201;
const UNPROCESSABLE = 422;

const repo: Repo = {
  name: 'raster-shared',
  fullName: 'MapColonies/raster-shared',
  defaultBranch: 'master',
  cloneUrl: 'https://github.com/MapColonies/raster-shared.git',
};

const draft: PullRequestDraft = {
  head: 'agent/bug/MAPCO-1-stop-the-loop',
  base: 'master',
  title: 'fix: stop the loop (MAPCO-1)',
  body: 'Written automatically by the MapColonies developer agent.',
};

function stubFetch(status: number, body?: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Promise.resolve({
        status,
        ok: status === CREATED,
        statusText: String(status),
        json: async () => Promise.resolve(body),
      })
    )
  );
}

/** Mints a different token every time, so "per call" is observable rather than asserted. */
function fakeTokens(): TokenProvider & { readonly minted: string[] } {
  const minted: string[] = [];

  return {
    minted,
    mint: async (): Promise<string> => {
      const token = `ghs-token-${minted.length + 1}`;
      minted.push(token);

      return Promise.resolve(token);
    },
  };
}

function lastCall(): { url: string; init: { headers: Record<string, string>; body: string; method: string } } {
  const [url, init] = vi.mocked(fetch).mock.calls.at(-1) as unknown as [string, { headers: Record<string, string>; body: string; method: string }];

  return { url, init };
}

function sentPayload(): Record<string, unknown> {
  return JSON.parse(lastCall().init.body) as Record<string, unknown>;
}

describe('RestPullRequests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should open the pull request against the repo and report its number and url.', async () => {
    /* eslint-disable-next-line @typescript-eslint/naming-convention -- GitHub REST wire format */
    stubFetch(CREATED, { number: 42, html_url: 'https://github.com/MapColonies/raster-shared/pull/42' });

    const pullRequest = await new RestPullRequests(fakeTokens()).open(repo, draft);

    expect(pullRequest).toStrictEqual({ number: 42, url: 'https://github.com/MapColonies/raster-shared/pull/42' });
    expect(lastCall().url).toBe('https://api.github.com/repos/MapColonies/raster-shared/pulls');
    expect(lastCall().init.method).toBe('POST');
  });

  it('should open a normal pull request, never a draft.', async () => {
    // A draft suppresses some workflows and gets scrolled past. Sent explicitly rather than
    // left to GitHub's default, because a default is not a decision anyone can read.
    /* eslint-disable-next-line @typescript-eslint/naming-convention -- GitHub REST wire format */
    stubFetch(CREATED, { number: 1, html_url: 'https://github.com/MapColonies/raster-shared/pull/1' });

    await new RestPullRequests(fakeTokens()).open(repo, draft);

    expect(sentPayload()).toMatchObject({ draft: false, head: draft.head, base: 'master', title: 'fix: stop the loop (MAPCO-1)' });
  });

  it('should set no reviewer and no assignee.', async () => {
    /* eslint-disable-next-line @typescript-eslint/naming-convention -- GitHub REST wire format */
    stubFetch(CREATED, { number: 1, html_url: 'https://github.com/MapColonies/raster-shared/pull/1' });

    await new RestPullRequests(fakeTokens()).open(repo, draft);

    expect(Object.keys(sentPayload())).toStrictEqual(['title', 'head', 'base', 'body', 'draft', 'maintainer_can_modify']);
  });

  it('should mint a token for every call rather than holding one.', async () => {
    // The criterion is that installation tokens are minted per run and never static. An
    // instance that outlives one token must not still be sending it.
    /* eslint-disable-next-line @typescript-eslint/naming-convention -- GitHub REST wire format */
    stubFetch(CREATED, { number: 1, html_url: 'https://github.com/MapColonies/raster-shared/pull/1' });
    const tokens = fakeTokens();
    const subject = new RestPullRequests(tokens);

    await subject.open(repo, draft);
    await subject.open(repo, draft);

    expect(tokens.minted).toStrictEqual(['ghs-token-1', 'ghs-token-2']);
    expect(lastCall().init.headers.authorization).toBe('Bearer ghs-token-2');
  });

  it('should fail every attempt to merge or approve, and reach no such endpoint.', async () => {
    // The API half of "merging and approving are attempted and observed to fail". The attempt is
    // made rather than described: the adapter is reached through a loose record so that asking it
    // to merge is a runtime question instead of a compile error. GitHub's own refusal — the App
    // installation genuinely lacking `pull_requests: write` on a merge — is MAPCO-11428's to
    // observe, and it is the second layer; this is the first one, which is that no call exists.
    /* eslint-disable-next-line @typescript-eslint/naming-convention -- GitHub REST wire format */
    stubFetch(CREATED, { number: 3, html_url: 'https://github.com/MapColonies/raster-shared/pull/3' });
    const subject = new RestPullRequests(fakeTokens());
    const loose = subject as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;

    for (const act of ['merge', 'approve', 'review', 'requestReviewers', 'assign', 'close', 'update']) {
      expect(loose[act]).toBeUndefined();
      expect(() => (loose[act] as (...args: unknown[]) => unknown)(repo, 1)).toThrow(TypeError);
    }

    await subject.open(repo, draft);

    // One request, and it is the one that opens a pull request. Nothing reached `/merge`, nothing
    // reached `/reviews`, and no method other than POST was used.
    const requests = vi.mocked(fetch).mock.calls.map((call) => ({ url: call[0] as string, method: (call[1] as { method: string }).method }));

    expect(requests).toStrictEqual([{ url: 'https://api.github.com/repos/MapColonies/raster-shared/pulls', method: 'POST' }]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(subject) as object).filter((name) => name !== 'constructor')).toStrictEqual(['open']);
  });

  it('should throw on anything that is not a created pull request.', async () => {
    // 422 is what GitHub answers when the branch was never pushed, or when a pull request for
    // it already exists. Neither means "no pull request was needed".
    stubFetch(UNPROCESSABLE);

    await expect(new RestPullRequests(fakeTokens()).open(repo, draft)).rejects.toThrow('422');
  });
});
