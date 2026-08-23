import { describe, expect, it } from 'vitest';
import { toRepoRelative } from '@src/vcs/paths';

const root = '/workspace/clone';

describe('toRepoRelative', () => {
  it('should turn the absolute path a file tool reports into the one git prints.', () => {
    // The whole reason this function exists: the Agent SDK's `Edit` and `Write` tools carry the
    // absolute `file_path` they were given, `git status --porcelain` prints repo-relative paths,
    // and a publish path that compares the two as strings stages nothing on every ticket.
    expect(toRepoRelative('/workspace/clone/src/tiles.ts', root)).toBe('src/tiles.ts');
  });

  it('should leave a path that is already repo-relative alone.', () => {
    expect(toRepoRelative('src/tiles.ts', root)).toBe('src/tiles.ts');
  });

  it('should normalise the noise a tool call can carry.', () => {
    expect(toRepoRelative('./src/tiles.ts', root)).toBe('src/tiles.ts');
    expect(toRepoRelative('/workspace/clone//src/./tiles.ts', root)).toBe('src/tiles.ts');
    expect(toRepoRelative('src/nested/../tiles.ts', root)).toBe('src/tiles.ts');
  });

  it('should refuse a path that resolves outside the checkout.', () => {
    // A refusal and not a throw: the caller names it in a log line rather than losing the ticket
    // over the model having mentioned a file somewhere else.
    expect(toRepoRelative('../elsewhere/thing.ts', root)).toBeNull();
    expect(toRepoRelative('/etc/passwd', root)).toBeNull();
    expect(toRepoRelative('src/../../escape.ts', root)).toBeNull();
    expect(toRepoRelative('/workspace/clone-2/src/tiles.ts', root)).toBeNull();
  });

  it('should refuse the checkout itself and a path that is only whitespace.', () => {
    expect(toRepoRelative(root, root)).toBeNull();
    expect(toRepoRelative('.', root)).toBeNull();
    expect(toRepoRelative('   ', root)).toBeNull();
    expect(toRepoRelative('', root)).toBeNull();
  });

  it('should keep a filename that merely starts with dots.', () => {
    // `..gitkeep` relativises to `..gitkeep`, and a naive `startsWith('..')` would read that as
    // an escape and silently drop a file the agent really did write.
    expect(toRepoRelative('/workspace/clone/src/..gitkeep', root)).toBe('src/..gitkeep');
    expect(toRepoRelative('.github/workflows/ci.yaml', root)).toBe('.github/workflows/ci.yaml');
  });
});
