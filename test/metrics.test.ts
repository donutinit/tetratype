import { describe, expect, test } from 'bun:test';
import {
  type KeystrokeOutcome,
  MAX_CONFUSIONS,
  MAX_DAYS,
  type Metrics,
  createMetrics,
  dayNumber,
  fatigueBucket,
  isEmpty,
  mergeMetrics,
  pruneMetrics,
  recordConfusion,
  recordKeystroke,
  speedBucket,
} from '../src/core/metrics';

const DAY = 86_400_000;

function stroke(overrides: Partial<KeystrokeOutcome> = {}): KeystrokeOutcome {
  return {
    expected: 'a',
    typed: 'a',
    wrong: false,
    intervalMs: 100,
    previousExpected: 'p',
    sessionIndex: 0,
    at: 10 * DAY,
    ...overrides,
  };
}

describe('bucketing', () => {
  test('speed bands are 25 ms wide and saturate at the top', () => {
    expect(speedBucket(0)).toBe(0);
    expect(speedBucket(24)).toBe(0);
    expect(speedBucket(25)).toBe(1);
    expect(speedBucket(99_999)).toBe(19);
    expect(speedBucket(-5)).toBe(0);
  });

  test('fatigue bands count keystrokes into the session', () => {
    expect(fatigueBucket(0)).toBe(0);
    expect(fatigueBucket(249)).toBe(0);
    expect(fatigueBucket(250)).toBe(1);
    expect(fatigueBucket(1_000_000)).toBe(11);
  });

  test('days are whole days since the epoch', () => {
    expect(dayNumber(0)).toBe(0);
    expect(dayNumber(DAY)).toBe(1);
    expect(dayNumber(DAY * 2.5)).toBe(2);
  });
});

describe('recordKeystroke', () => {
  test('counts a correct keystroke against its target', () => {
    const metrics = createMetrics();
    recordKeystroke(metrics, stroke());
    expect(metrics.totals).toMatchObject({ attempts: 1, errors: 0 });
    expect(metrics.chars.a).toEqual({ attempts: 1, errors: 0 });
    expect(metrics.transitions['p>a']).toEqual({ attempts: 1, errors: 0 });
  });

  test('counts a mistake against the character that was owed', () => {
    const metrics = createMetrics();
    recordKeystroke(metrics, stroke({ expected: 'a', typed: 's', wrong: true }));
    expect(metrics.totals.errors).toBe(1);
    expect(metrics.chars.a).toEqual({ attempts: 1, errors: 1 });
    expect(metrics.chars.s).toBeUndefined();
  });

  test('falls back to the typed character when nothing was expected', () => {
    const metrics = createMetrics();
    recordKeystroke(metrics, stroke({ expected: null, typed: 'z' }));
    expect(metrics.chars.z).toEqual({ attempts: 1, errors: 0 });
  });

  test('skips the transition when there is no previous character', () => {
    const metrics = createMetrics();
    recordKeystroke(metrics, stroke({ previousExpected: null }));
    expect(Object.keys(metrics.transitions)).toEqual([]);
  });

  test('files the keystroke into speed, fatigue and day buckets', () => {
    const metrics = createMetrics();
    recordKeystroke(metrics, stroke({ intervalMs: 60, sessionIndex: 300, at: 5 * DAY }));
    expect(metrics.speed['2']).toMatchObject({ attempts: 1, samples: 1, sumMs: 60 });
    expect(metrics.fatigue['1']).toMatchObject({ attempts: 1, sumMs: 60 });
    expect(metrics.days['5']).toMatchObject({ attempts: 1, sumMs: 60 });
  });

  test('counts attempts but no interval when the run just started', () => {
    const metrics = createMetrics();
    recordKeystroke(metrics, stroke({ intervalMs: null }));
    expect(metrics.days['10']).toMatchObject({ attempts: 1, samples: 0, sumMs: 0 });
    expect(Object.keys(metrics.speed)).toEqual([]);
  });
});

describe('recordConfusion', () => {
  test('accumulates count and recovery time', () => {
    const metrics = createMetrics();
    recordConfusion(metrics, 'a', 's', { recoveryMs: 400, uncorrected: false });
    recordConfusion(metrics, 'a', 's', { recoveryMs: 600, uncorrected: false });
    const record = metrics.confusions['a>s'];
    expect(record).toMatchObject({ count: 2, recoveryMs: 1000, recoveryCount: 2 });
    expect(metrics.totals.corrected).toBe(2);
  });

  test('tracks mistakes that were never fixed', () => {
    const metrics = createMetrics();
    recordConfusion(metrics, 'a', 's', { recoveryMs: null, uncorrected: true });
    expect(metrics.confusions['a>s']).toMatchObject({ count: 1, uncorrected: 1, recoveryCount: 0 });
    expect(metrics.totals.uncorrected).toBe(1);
  });

  test('keeps the two directions of a swap apart', () => {
    const metrics = createMetrics();
    recordConfusion(metrics, 'a', 's', { recoveryMs: 100, uncorrected: false });
    recordConfusion(metrics, 's', 'a', { recoveryMs: 100, uncorrected: false });
    expect(Object.keys(metrics.confusions).sort()).toEqual(['a>s', 's>a']);
  });
});

describe('mergeMetrics', () => {
  function seeded(): Metrics {
    const metrics = createMetrics();
    recordKeystroke(metrics, stroke());
    recordConfusion(metrics, 'a', 's', { recoveryMs: 300, uncorrected: false });
    metrics.sessions = 1;
    return metrics;
  }

  test('sums every counter', () => {
    const base = seeded();
    mergeMetrics(base, seeded());
    expect(base.totals.attempts).toBe(2);
    expect(base.chars.a).toEqual({ attempts: 2, errors: 0 });
    expect(base.transitions['p>a']).toEqual({ attempts: 2, errors: 0 });
    expect(base.confusions['a>s']).toMatchObject({ count: 2, recoveryMs: 600 });
    expect(base.days['10']?.attempts).toBe(2);
    expect(base.sessions).toBe(2);
  });

  test('carries over entries only one side has', () => {
    const base = createMetrics();
    const delta = createMetrics();
    recordKeystroke(delta, stroke({ expected: 'z', typed: 'z', previousExpected: 'y' }));
    mergeMetrics(base, delta);
    expect(base.chars.z).toEqual({ attempts: 1, errors: 0 });
    expect(base.transitions['y>z']).toEqual({ attempts: 1, errors: 0 });
  });

  test('merging an empty delta changes nothing', () => {
    const base = seeded();
    mergeMetrics(base, createMetrics());
    expect(base.totals.attempts).toBe(1);
  });
});

describe('pruneMetrics', () => {
  test('drops the rarest confusions past the cap', () => {
    const metrics = createMetrics();
    for (let i = 0; i < MAX_CONFUSIONS + 50; i++) {
      const record = { expected: 'a', typed: `x${i}`, count: i + 1 };
      metrics.confusions[`a>x${i}`] = {
        ...record,
        recoveryMs: 0,
        recoveryCount: 0,
        uncorrected: 0,
      };
    }
    pruneMetrics(metrics);
    expect(Object.keys(metrics.confusions)).toHaveLength(MAX_CONFUSIONS);
    // The survivors are the ones seen most often.
    expect(metrics.confusions['a>x0']).toBeUndefined();
    expect(metrics.confusions[`a>x${MAX_CONFUSIONS + 49}`]).toBeDefined();
  });

  test('keeps only the most recent days', () => {
    const metrics = createMetrics();
    for (let day = 0; day < MAX_DAYS + 20; day++) {
      metrics.days[String(day)] = { samples: 1, sumMs: 1, attempts: 1, errors: 0 };
    }
    pruneMetrics(metrics);
    const days = Object.keys(metrics.days)
      .map(Number)
      .sort((a, b) => a - b);
    expect(days).toHaveLength(MAX_DAYS);
    expect(days[0]).toBe(20);
  });
});

describe('isEmpty', () => {
  test('is true before anything is recorded', () => {
    expect(isEmpty(createMetrics())).toBe(true);
  });

  test('is false once a keystroke lands', () => {
    const metrics = createMetrics();
    recordKeystroke(metrics, stroke());
    expect(isEmpty(metrics)).toBe(false);
  });
});
