import { describe, expect, it } from 'vitest';
import { attemptsSoFar, countAttempt } from '@src/budget/attempt';

/** The cap the poll query is built with. Passed in, so this module never depends on the cycle. */
const ATTEMPT_CAP = 2;

describe('attemptsSoFar', () => {
  it('should read a freshly enrolled ticket as having no attempts behind it.', () => {
    expect(attemptsSoFar(['agent-ready'])).toBe(0);
  });

  it('should read the counter a ticket already carries.', () => {
    expect(attemptsSoFar(['agent-ready', 'agent-attempted-1'])).toBe(1);
  });

  it('should take the highest counter rather than how many counters there are.', () => {
    // A ticket that somehow carries both has two attempts behind it, not three. Counting the
    // labels instead would push a ticket past the cap on the strength of a duplicate.
    expect(attemptsSoFar(['agent-attempted-1', 'agent-attempted-2'])).toBe(2);
  });

  it('should ignore a label under the prefix that is not a number.', () => {
    // Somebody else's label, not a counter. Reading it as zero would be harmless; reading it as
    // a counter and deleting it in `countAttempt` would not be.
    expect(attemptsSoFar(['agent-attempted-soon', 'agent-attempted-'])).toBe(0);
  });
});

describe('countAttempt', () => {
  it('should put the first counter on a ticket that has never been attempted.', () => {
    expect(countAttempt(['agent-ready'], ATTEMPT_CAP)).toEqual(['agent-ready', 'agent-attempted-1']);
  });

  it('should replace the old counter rather than leaving both on the ticket.', () => {
    // One counter per ticket: the query excludes on an exact label, so a ticket wearing both
    // `agent-attempted-1` and `agent-attempted-2` invites somebody to read the wrong one.
    expect(countAttempt(['agent-ready', 'agent-attempted-1'], ATTEMPT_CAP)).toEqual(['agent-ready', 'agent-attempted-2']);
  });

  it('should stop counting at the cap instead of pushing a ticket past it.', () => {
    // The non-obvious one, and the reason this clamps. `buildPollQuery` excludes the label
    // *exactly* at the cap — `labels not in ("agent-attempted-2")` — so writing
    // `agent-attempted-3` would not tighten anything, it would make an exhausted ticket visible
    // to the poll again and hand it back to the worker forever. A ticket at the cap is already
    // invisible, so leaving its counter alone costs nothing.
    expect(countAttempt(['agent-ready', 'agent-attempted-2'], ATTEMPT_CAP)).toEqual(['agent-ready', 'agent-attempted-2']);
  });

  it('should leave every label that is not one of the worker’s counters alone.', () => {
    // `agent-ready` above all: enrolment is a human's decision, and running out of budget is not
    // a reason to take a ticket out of the programme.
    expect(countAttempt(['agent-ready', 'sprint-42', 'agent-attempted-soon'], ATTEMPT_CAP)).toEqual([
      'agent-ready',
      'sprint-42',
      'agent-attempted-soon',
      'agent-attempted-1',
    ]);
  });

  it('should count an attempt on a ticket carrying no labels at all.', () => {
    expect(countAttempt([], ATTEMPT_CAP)).toEqual(['agent-attempted-1']);
  });

  it('should never write a counter no query could exclude, whatever cap it is given.', () => {
    // A cap below 1 is not a thing the query can express, and `agent-attempted-0` would be a
    // counter that excludes nothing — a ticket wearing one is a ticket that never stops.
    expect(countAttempt(['agent-ready'], 0)).toEqual(['agent-ready', 'agent-attempted-1']);
  });
});
