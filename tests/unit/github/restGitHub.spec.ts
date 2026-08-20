import { afterEach, describe, expect, it, vi } from 'vitest';
import { RestGitHub } from '@src/github/restGitHub';

const OK = 200;
const NOT_FOUND = 404;
const FORBIDDEN = 403;

function stubFetch(status: number, body?: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Promise.resolve({
        status,
        ok: status === OK,
        statusText: String(status),
        json: async () => Promise.resolve(body),
      })
    )
  );
}

const canonicalBody = {
  /* eslint-disable @typescript-eslint/naming-convention -- GitHub REST wire format */
  name: 'LLM-configuration',
  full_name: 'MapColonies/LLM-configuration',
  default_branch: 'master',
  clone_url: 'https://github.com/MapColonies/LLM-configuration.git',
  /* eslint-enable @typescript-eslint/naming-convention */
};

function headersOfLastCall(): Record<string, string> {
  const [, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, { headers: Record<string, string> }];

  return init.headers;
}

describe('RestGitHub', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should return GitHub's canonical spelling, not the one it was asked for.", async () => {
    stubFetch(OK, canonicalBody);

    const repo = await new RestGitHub().findRepo('LLM-Configuration');

    expect(repo?.name).toBe('LLM-configuration');
    expect(repo?.defaultBranch).toBe('master');
  });

  it('should report a missing repo as null rather than throwing.', async () => {
    stubFetch(NOT_FOUND);

    await expect(new RestGitHub().findRepo('nope')).resolves.toBeNull();
  });

  it('should throw on a failure that is not a missing repo, so it is never mistaken for one.', async () => {
    // A rate limit or an auth problem must not read as "that repo does not exist" — the
    // worker would refuse the ticket and bump its attempt count for the wrong reason.
    stubFetch(FORBIDDEN);

    await expect(new RestGitHub().findRepo('anything')).rejects.toThrow('403');
  });

  it('should send a bearer token when it has one.', async () => {
    stubFetch(OK, canonicalBody);

    await new RestGitHub('secret-token').findRepo('some-repo');

    expect(headersOfLastCall().authorization).toBe('Bearer secret-token');
  });

  it('should stay anonymous when it has no token.', async () => {
    stubFetch(OK, canonicalBody);

    await new RestGitHub().findRepo('some-repo');

    expect(headersOfLastCall().authorization).toBeUndefined();
  });
});
