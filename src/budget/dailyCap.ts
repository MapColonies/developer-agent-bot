import type { Clock, DailyCap, DailyCapState } from './types';

const MS_PER_DAY = 86_400_000;

/** The UTC day a moment falls in, as a whole number of days since the epoch. */
function dayOf(millis: number): number {
  return Math.floor(millis / MS_PER_DAY);
}

/**
 * The per-day started-ticket counter (MAPCO-11435).
 *
 * ## The counter lives in memory, and that is a limitation, not an oversight
 *
 * Jira is the sole source of truth for this service: there is no database and nothing on disk
 * outlives a run (MAPCO-11430). A counter is not a thing Jira can hold — a global daily total
 * would mean a read-modify-write across every ticket the worker has ever touched — so it is a
 * variable in a long-lived process instead. That is coherent, because the process outlives a
 * cycle by design (MAPCO-11430 chose a Deployment over a CronJob for exactly this kind of
 * reason), but it means the cap is **per process-day, not per calendar day globally**: a
 * redeploy, a crash or an eviction resets it, so a pod that restarts three times in a morning
 * can start three times the cap. Read it as a brake on a healthy process, not as a billing
 * guarantee. A genuinely global cap needs a store, and inventing one here is out of scope.
 *
 * Day boundaries are UTC and are evaluated lazily: nothing schedules a reset, the window rolls
 * forward the next time the counter is asked anything. An idle worker therefore holds no timer,
 * and no count can change underneath a cycle that is already running.
 *
 * Asking (`state`) and counting (`recordStart`) are separate calls, and what is counted is
 * tickets the worker *held*, not tickets it looked at. A claim lost to a human spends nothing,
 * and burning a day's allowance on races would idle the worker for the rest of the day. The
 * cost is that two tickets can read the same last slot as free when `maxConcurrentTickets` is
 * above 1, so a day can end a ticket or two over the cap; the counter reports the real number
 * rather than clamping it, and both knobs default to 1.
 */
function createDailyCap(limit: number, clock: Clock = Date.now): DailyCap {
  let day = dayOf(clock());
  let started = 0;

  /** Roll the window forward if the clock has crossed midnight since the last question. */
  const rollover = (): void => {
    const today = dayOf(clock());

    if (today !== day) {
      day = today;
      started = 0;
    }
  };

  const state = (): DailyCapState => {
    rollover();

    return { startedToday: started, limit, exhausted: started >= limit };
  };

  return {
    recordStart: (): void => {
      // Records something that already happened, so it never refuses. Guarding here would
      // hide the overshoot described above instead of reporting it.
      rollover();
      started += 1;
    },
    state,
  };
}

export { createDailyCap, dayOf };
