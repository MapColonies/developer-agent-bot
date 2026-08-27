import { describe, expect, it } from 'vitest';
import { AgentConfigError, API_KEY_ENV, readApiKey } from '@src/agent/apiKey';

/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */

describe('readApiKey', () => {
  it('should take the key the deployment put in the environment.', () => {
    expect(readApiKey({ ANTHROPIC_API_KEY: 'sk-from-the-secret' })).toBe('sk-from-the-secret');
  });

  it('should trim it, because a Secret mounted from a file usually ends in a newline.', () => {
    expect(readApiKey({ ANTHROPIC_API_KEY: 'sk-from-the-secret\n' })).toBe('sk-from-the-secret');
  });

  it('should refuse to start with no key rather than discovering it on the first ticket.', () => {
    // A worker with no key cannot do the one thing it exists for, and every ticket it claimed
    // in the meantime would be a claim burnt for nothing.
    expect(() => readApiKey({})).toThrow(AgentConfigError);
  });

  it('should treat an empty value as unset, which is what a missing Secret key looks like.', () => {
    expect(() => readApiKey({ ANTHROPIC_API_KEY: '   ' })).toThrow(AgentConfigError);
  });

  it('should name the variable that has to be set, so the message is actionable.', () => {
    expect(() => readApiKey({})).toThrow(API_KEY_ENV);
  });

  it('should never fall back to an interactive-login credential.', () => {
    // The acceptance criterion is "never an interactive login", and the way that gets broken
    // is a default rather than a decision — a session token picked up because it was lying
    // around. On a developer's laptop that would bill a person's account and look like success.
    expect(() => readApiKey({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-of-a-person' })).toThrow(AgentConfigError);
  });

  it('should say that it saw a login token and would not use it.', () => {
    expect(() => readApiKey({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-of-a-person' })).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/u);
  });

  it('should not accept the auth-token variable as a key either.', () => {
    expect(() => readApiKey({ ANTHROPIC_AUTH_TOKEN: 'bearer-of-something-else' })).toThrow(AgentConfigError);
  });

  it('should be a fault of its own kind, so a bad deployment cannot read as a failed ticket.', () => {
    expect(() => readApiKey({})).toThrow(expect.objectContaining({ name: 'AgentConfigError' }));
  });
});

/* eslint-enable @typescript-eslint/naming-convention */
