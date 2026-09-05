import { describe, expect, test } from 'bun:test';
import { COARSE_TIMER_MS, isCoarse, probeTimerResolution } from '../src/core/timing';

/** A clock that advances in fixed steps, like a rounded browser timer. */
function steppedClock(stepMs: number) {
  let value = 0;
  let calls = 0;
  return {
    now: () => {
      // Advance only every third read, so zero-delta reads are exercised too.
      if (calls++ % 3 === 0) value += stepMs;
      return value;
    },
  };
}

describe('probeTimerResolution', () => {
  test('detects a one-millisecond clock', () => {
    expect(probeTimerResolution(steppedClock(1), 10)).toBe(1);
  });

  test('detects the coarse clock resistFingerprinting produces', () => {
    expect(probeTimerResolution(steppedClock(100), 10)).toBe(100);
  });

  test('detects a high-resolution clock', () => {
    expect(probeTimerResolution(steppedClock(0.005), 10)).toBeCloseTo(0.005, 6);
  });

  test('returns zero for a clock that never advances', () => {
    expect(probeTimerResolution({ now: () => 42 }, 4)).toBe(0);
  });

  test('terminates on a frozen clock rather than spinning forever', () => {
    const started = Date.now();
    probeTimerResolution({ now: () => 0 }, 1000);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('isCoarse', () => {
  test('flags clocks too rounded for keystroke timing', () => {
    expect(isCoarse(100)).toBe(true);
    expect(isCoarse(COARSE_TIMER_MS + 0.1)).toBe(true);
  });

  test('accepts millisecond-grade clocks', () => {
    expect(isCoarse(1)).toBe(false);
    expect(isCoarse(0)).toBe(false);
  });
});
