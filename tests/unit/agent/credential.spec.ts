import { describe, expect, it } from 'vitest';
import { AgentConfigError, API_KEY_ENV, AUTH_MODE_ENV, readModelCredential, SUBSCRIPTION_ENV } from '@src/agent/credential';

/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */

describe('readModelCredential', () => {
  it('should default to the org-billed API key when no mode is configured.', () => {
    // The default is the safe direction: a deployment that says nothing about billing gets the
    // account it was provisioned with, not whatever personal token is lying around.
    expect(readModelCredential({ ANTHROPIC_API_KEY: 'sk-from-the-secret' })).toStrictEqual({
      mode: 'api-key',
      source: API_KEY_ENV,
      value: 'sk-from-the-secret',
    });
  });

  it('should take the subscription token when that mode is configured.', () => {
    expect(readModelCredential({ MODEL_AUTH: 'subscription', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-of-a-person' })).toStrictEqual({
      mode: 'subscription',
      source: SUBSCRIPTION_ENV,
      value: 'oauth-of-a-person',
    });
  });

  it('should accept the mode however it was cased in the manifest.', () => {
    expect(readModelCredential({ MODEL_AUTH: 'Subscription', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' }).mode).toBe('subscription');
  });

  it('should trim, because a Secret mounted from a file usually ends in a newline.', () => {
    expect(readModelCredential({ ANTHROPIC_API_KEY: 'sk-from-the-secret\n' }).value).toBe('sk-from-the-secret');
  });

  it('should never use one mode’s credential for the other.', () => {
    // The whole point of the mode being explicit. Falling back would make the billed party a
    // property of the pod's environment rather than of a decision, and a run that quietly spent
    // a person's quota would look exactly like a working one.
    expect(() => readModelCredential({ MODEL_AUTH: 'api-key', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-of-a-person' })).toThrow(AgentConfigError);
    expect(() => readModelCredential({ MODEL_AUTH: 'subscription', ANTHROPIC_API_KEY: 'sk-from-the-secret' })).toThrow(AgentConfigError);
  });

  it('should point at the credential it found but would not use, because that is the likely mistake.', () => {
    // Setting the token and forgetting the mode is the mistake an operator actually makes.
    expect(() => readModelCredential({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-of-a-person' })).toThrow(/CLAUDE_CODE_OAUTH_TOKEN is set/u);
  });

  it('should refuse an unrecognised mode rather than falling back to the default.', () => {
    // A typo would otherwise bill the wrong account silently.
    expect(() => readModelCredential({ MODEL_AUTH: 'subscribtion', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' })).toThrow(/MODEL_AUTH must be one of/u);
  });

  it('should refuse to start with no credential rather than discovering it on the first ticket.', () => {
    expect(() => readModelCredential({})).toThrow(AgentConfigError);
  });

  it('should treat an empty value as unset, which is what a missing Secret key looks like.', () => {
    expect(() => readModelCredential({ ANTHROPIC_API_KEY: '   ' })).toThrow(AgentConfigError);
    expect(() => readModelCredential({ MODEL_AUTH: 'subscription', CLAUDE_CODE_OAUTH_TOKEN: '  ' })).toThrow(AgentConfigError);
  });

  it('should name the variable the configured mode needs, so the message is actionable.', () => {
    expect(() => readModelCredential({})).toThrow(API_KEY_ENV);
    expect(() => readModelCredential({ MODEL_AUTH: 'subscription' })).toThrow(SUBSCRIPTION_ENV);
    expect(() => readModelCredential({ MODEL_AUTH: 'subscription' })).toThrow(AUTH_MODE_ENV);
  });

  it('should be a fault of its own kind, so a bad deployment cannot read as a failed ticket.', () => {
    expect(() => readModelCredential({})).toThrow(expect.objectContaining({ name: 'AgentConfigError' }));
  });
});

/* eslint-enable @typescript-eslint/naming-convention */
