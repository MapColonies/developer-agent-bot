import type { Logger } from '@map-colonies/js-logger';
import { runCycle, type CycleDeps } from './cycle';

export interface Scheduler {
  start: () => void;
  stop: () => Promise<void>;
}

/**
 * The internal scheduler that makes this a long-lived Deployment rather than a CronJob
 * (MAPCO-11430). A ticket in flight belongs to a process that is still alive, and "boot"
 * stays a rare event — a crash, a redeploy, an eviction — rather than something that
 * happens every tick.
 *
 * Runs never overlap. A cycle that outlives its interval delays the next tick instead of
 * doubling up on it.
 */
export function createScheduler(deps: CycleDeps, intervalMs: number, logger: Logger): Scheduler {
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<unknown> = Promise.resolve();
  let stopped = false;

  const tick = (): void => {
    if (stopped) {
      return;
    }

    inFlight = runCycle(deps)
      .catch((error: unknown) => {
        // runCycle already reports a failed poll; this only catches a cycle that threw
        // where it promised not to. Never let it kill the process.
        logger.error({ msg: 'cycle threw unexpectedly', err: error });
      })
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(tick, intervalMs);
        }
      });
  };

  return {
    start: (): void => {
      logger.info({ msg: 'scheduler started', intervalMs });
      tick();
    },
    stop: async (): Promise<void> => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      await inFlight;
      logger.info({ msg: 'scheduler stopped' });
    },
  };
}
