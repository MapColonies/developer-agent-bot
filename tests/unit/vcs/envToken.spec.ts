import { describe, expect, it } from 'vitest';
import { envTokenProvider, GITHUB_TOKEN_ENV, readGitHubToken, TokenError } from '@src/vcs/envToken';

/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */
describe('readGitHubToken', () => {
  it('should refuse at boot rather than once per ticket.', () => {
    // Discovered per ticket, a missing credential costs a claim, a comment naming an environment
    // variable and an attempt on somebody's ticket — twice over, which retires it from the queue.
    expect(() => readGitHubToken({})).toThrow(TokenError);
  });

  it('should name the variable and the ticket that replaces it.', () => {
    expect(() => readGitHubToken({})).toThrow(new RegExp(`${GITHUB_TOKEN_ENV}.*MAPCO-11428`, 'su'));
  });

  it('should accept the token the deployment supplied.', () => {
    expect(readGitHubToken({ GITHUB_TOKEN: 'ghp_atoken' })).toBe('ghp_atoken');
  });
});

describe('envTokenProvider', () => {
  it('should mint the token the deployment supplied.', async () => {
    await expect(envTokenProvider({ GITHUB_TOKEN: 'ghp_atoken' }).mint()).resolves.toBe('ghp_atoken');
  });

  it('should refuse rather than offer git an empty credential.', async () => {
    // An empty token reaches git as an empty password, which fails with a message about
    // authentication rather than about a Secret that never arrived.
    await expect(envTokenProvider({ GITHUB_TOKEN: '  ' }).mint()).rejects.toThrow(TokenError);
  });

  it('should read the environment on every call, as the App will.', async () => {
    // Nothing downstream may be built around a credential that is fetched once and cached: the
    // real provider hands out a token that expires in an hour.
    const env: NodeJS.ProcessEnv = { GITHUB_TOKEN: 'first' };
    const tokens = envTokenProvider(env);

    await expect(tokens.mint()).resolves.toBe('first');

    env.GITHUB_TOKEN = 'second';

    await expect(tokens.mint()).resolves.toBe('second');
  });
});
/* eslint-enable @typescript-eslint/naming-convention */
