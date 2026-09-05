/**
 * Clock resolution probe.
 *
 * Firefox rounds `performance.now()` and `event.timeStamp` to defend against
 * fingerprinting, and LibreWolf ships that defence turned up much further. At
 * 100 ms granularity every inter-key interval collapses onto a few values and
 * the whole profile becomes meaningless, so the dashboard measures the real
 * granularity and says so rather than quietly reporting nonsense.
 */

/** Above this, per-keystroke timings are too coarse to be trusted. */
export const COARSE_TIMER_MS = 5;

export interface Clock {
  now: () => number;
}

const DEFAULT_CLOCK: Clock = { now: () => performance.now() };

/**
 * Estimates timer granularity as the smallest non-zero gap between readings.
 *
 * Bounded by both a target number of distinct gaps and a hard iteration cap so
 * it cannot spin on a clock that never advances.
 */
export function probeTimerResolution(clock: Clock = DEFAULT_CLOCK, targetGaps = 24): number {
  const MAX_ITERATIONS = 200_000;
  let smallest = Number.POSITIVE_INFINITY;
  let previous = clock.now();
  let gaps = 0;

  for (let i = 0; i < MAX_ITERATIONS && gaps < targetGaps; i++) {
    const current = clock.now();
    const delta = current - previous;
    if (delta > 0) {
      if (delta < smallest) smallest = delta;
      previous = current;
      gaps++;
    }
  }

  return Number.isFinite(smallest) ? smallest : 0;
}

/** True when the clock is too coarse for meaningful per-keystroke timing. */
export function isCoarse(resolutionMs: number): boolean {
  return resolutionMs > COARSE_TIMER_MS;
}
