import { describe, expect, it } from 'vitest';
import { createDailyCap, dayOf } from '@src/budget/dailyCap';

/**
 * A fixed moment, mid-afternoon UTC. Every test here drives its own clock: the wall clock is
 * never read, so none of this changes behaviour depending on when the suite runs — including
 * when it runs a few minutes before midnight.
 */
const NOON = Date.UTC(2026, 7, 20, 12);
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

describe('createDailyCap', () => {
  it('should let tickets start until the day is full.', () => {
    const cap = createDailyCap(2, () => NOON);

    expect(cap.state()).toStrictEqual({ startedToday: 0, limit: 2, exhausted: false });

    cap.recordStart();

    expect(cap.state()).toStrictEqual({ startedToday: 1, limit: 2, exhausted: false });

    cap.recordStart();

    expect(cap.state()).toStrictEqual({ startedToday: 2, limit: 2, exhausted: true });
  });

  it('should keep the day full for the rest of that day.', () => {
    let now = NOON;
    const cap = createDailyCap(1, () => now);

    cap.recordStart();
    now = NOON + 11 * MS_PER_HOUR;

    // 23:00 the same day. Anything that resets before midnight is a cap that does not cap.
    expect(cap.state().exhausted).toBe(true);
  });

  it('should start a fresh count once the clock crosses into the next UTC day.', () => {
    let now = NOON;
    const cap = createDailyCap(1, () => now);

    cap.recordStart();
    now = NOON + 13 * MS_PER_HOUR;

    expect(cap.state()).toStrictEqual({ startedToday: 0, limit: 1, exhausted: false });
  });

  it('should roll a window forward however long the worker sat idle, without a timer to do it.', () => {
    let now = NOON;
    const cap = createDailyCap(1, () => now);

    cap.recordStart();
    now = NOON + 5 * MS_PER_DAY;

    // Nothing schedules a reset; the window moves on the next question. Five days of silence
    // must land on one clean window rather than needing five ticks to catch up.
    expect(cap.state()).toStrictEqual({ startedToday: 0, limit: 1, exhausted: false });
  });

  it('should count a ticket started after midnight against the new day.', () => {
    let now = NOON;
    const cap = createDailyCap(2, () => now);

    cap.recordStart();
    now = NOON + 13 * MS_PER_HOUR;
    cap.recordStart();

    expect(cap.state().startedToday).toBe(1);
  });

  it('should report the real count when concurrent starts overshoot the cap, rather than clamping it.', () => {
    const cap = createDailyCap(1, () => NOON);

    cap.recordStart();
    cap.recordStart();

    // Two tickets can read the same last slot as free when MAX_CONCURRENT_TICKETS is above 1.
    // The counter reports what happened — clamping it would hide the overshoot instead.
    expect(cap.state()).toStrictEqual({ startedToday: 2, limit: 1, exhausted: true });
  });

  it('should take its idea of today from the injected clock and nothing else.', () => {
    const cap = createDailyCap(1, () => 0);

    cap.recordStart();

    // The epoch, decades before the suite runs: a cap that consulted the real clock anywhere
    // would see a different day here and reset.
    expect(cap.state().exhausted).toBe(true);
  });
});

describe('dayOf', () => {
  it('should split days at UTC midnight rather than at a local one.', () => {
    // The pod's timezone is not something anyone chooses, so the window must not move with it.
    expect(dayOf(Date.UTC(2026, 7, 20, 23, 59, 59, 999))).toBe(dayOf(Date.UTC(2026, 7, 20, 0, 0, 0, 0)));
    expect(dayOf(Date.UTC(2026, 7, 21, 0, 0, 0, 0))).toBe(dayOf(Date.UTC(2026, 7, 20, 12)) + 1);
  });
});
