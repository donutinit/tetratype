import { describe, expect, test } from 'bun:test';
import {
  accuracyCliff,
  charAccuracy,
  confusionRanking,
  dailyHistory,
  fatigueCurve,
  speedAccuracyCurve,
  summarizeAccuracy,
} from '../src/core/insights';
import { type Metrics, createMetrics, recordConfusion, recordKeystroke } from '../src/core/metrics';

const DAY = 86_400_000;

/** Records `times` keystrokes, `errors` of which went wrong. */
function type(
  metrics: Metrics,
  opts: { expected: string; typed?: string; times: number; errors?: number } & Partial<{
    intervalMs: number;
    sessionIndex: number;
    at: number;
    previousExpected: string;
  }>,
): void {
  const errors = opts.errors ?? 0;
  for (let i = 0; i < opts.times; i++) {
    const wrong = i < errors;
    recordKeystroke(metrics, {
      expected: opts.expected,
      typed: wrong ? (opts.typed ?? 'x') : opts.expected,
      wrong,
      intervalMs: opts.intervalMs ?? 100,
      previousExpected: opts.previousExpected ?? 'p',
      sessionIndex: opts.sessionIndex ?? 0,
      at: opts.at ?? 10 * DAY,
    });
  }
}

describe('confusionRanking', () => {
  test('ranks by the time each mistake has cost', () => {
    const metrics = createMetrics();
    for (let i = 0; i < 10; i++) {
      recordConfusion(metrics, 'r', 't', { recoveryMs: 800, uncorrected: false });
    }
    for (let i = 0; i < 30; i++) {
      recordConfusion(metrics, 'a', 's', { recoveryMs: 100, uncorrected: false });
    }
    metrics.totals.errors = 40;

    const ranked = confusionRanking(metrics);
    expect(ranked[0]).toMatchObject({ expected: 'r', typed: 't', count: 10, msLost: 8000 });
    expect(ranked[0]?.meanRecoveryMs).toBe(800);
    expect(ranked[1]?.expected).toBe('a');
  });

  test('explains the mistake in terms of the keyboard', () => {
    const metrics = createMetrics();
    for (let i = 0; i < 5; i++) {
      recordConfusion(metrics, 'r', 't', { recoveryMs: 100, uncorrected: false });
      recordConfusion(metrics, 'e', 'd', { recoveryMs: 100, uncorrected: false });
      recordConfusion(metrics, 'a', 'l', { recoveryMs: 100, uncorrected: false });
    }
    const byPair = new Map(confusionRanking(metrics).map((c) => [`${c.expected}${c.typed}`, c]));
    // `r` and `t` are neighbours under the same index finger.
    expect(byPair.get('rt')?.relation).toBe('same-finger');
    expect(byPair.get('ed')?.relation).toBe('same-finger');
    expect(byPair.get('al')?.relation).toBe('alternate');
  });

  test('drops one-off slips', () => {
    const metrics = createMetrics();
    recordConfusion(metrics, 'q', 'w', { recoveryMs: 100, uncorrected: false });
    expect(confusionRanking(metrics)).toEqual([]);
    expect(confusionRanking(metrics, { minCount: 1 })).toHaveLength(1);
  });

  test('reports share of all mistakes', () => {
    const metrics = createMetrics();
    for (let i = 0; i < 5; i++) {
      recordConfusion(metrics, 'a', 's', { recoveryMs: 10, uncorrected: false });
    }
    metrics.totals.errors = 10;
    expect(confusionRanking(metrics)[0]?.share).toBeCloseTo(0.5, 6);
  });
});

describe('charAccuracy', () => {
  test('ranks characters by how often they go wrong', () => {
    const metrics = createMetrics();
    type(metrics, { expected: 'a', times: 100, errors: 1 });
    type(metrics, { expected: 'ñ', times: 100, errors: 20 });
    const ranked = charAccuracy(metrics);
    expect(ranked[0]?.char).toBe('ñ');
    expect(ranked[0]?.rate).toBeCloseTo(0.2, 6);
  });

  test('ignores characters with too little data', () => {
    const metrics = createMetrics();
    type(metrics, { expected: 'z', times: 3, errors: 3 });
    expect(charAccuracy(metrics)).toEqual([]);
  });
});

describe('speedAccuracyCurve', () => {
  test('shows accuracy falling as the keys come faster', () => {
    const metrics = createMetrics();
    type(metrics, { expected: 'a', times: 100, errors: 30, intervalMs: 30 });
    type(metrics, { expected: 'a', times: 100, errors: 2, intervalMs: 200 });

    const curve = speedAccuracyCurve(metrics);
    expect(curve).toHaveLength(2);
    expect(curve[0]?.fromMs).toBe(25);
    expect(curve[0]?.rate).toBeCloseTo(0.3, 6);
    expect(curve[1]?.fromMs).toBe(200);
    expect(curve[1]?.rate).toBeCloseTo(0.02, 6);
  });

  test('ignores bands with too few keystrokes', () => {
    const metrics = createMetrics();
    type(metrics, { expected: 'a', times: 5, intervalMs: 100 });
    expect(speedAccuracyCurve(metrics)).toEqual([]);
  });
});

describe('accuracyCliff', () => {
  test('finds the fastest band still under the error threshold', () => {
    const metrics = createMetrics();
    type(metrics, { expected: 'a', times: 100, errors: 40, intervalMs: 30 });
    type(metrics, { expected: 'a', times: 100, errors: 20, intervalMs: 80 });
    type(metrics, { expected: 'a', times: 100, errors: 1, intervalMs: 130 });
    type(metrics, { expected: 'a', times: 100, errors: 1, intervalMs: 200 });

    const cliff = accuracyCliff(speedAccuracyCurve(metrics));
    expect(cliff?.fromMs).toBe(125);
  });

  test('returns null when every band is past the threshold', () => {
    const metrics = createMetrics();
    type(metrics, { expected: 'a', times: 100, errors: 50, intervalMs: 30 });
    expect(accuracyCliff(speedAccuracyCurve(metrics))).toBeNull();
  });

  test('handles an empty curve', () => {
    expect(accuracyCliff([])).toBeNull();
  });
});

describe('fatigueCurve', () => {
  test('shows accuracy and speed drifting over a long session', () => {
    const metrics = createMetrics();
    type(metrics, { expected: 'a', times: 100, errors: 2, intervalMs: 100, sessionIndex: 10 });
    type(metrics, { expected: 'a', times: 100, errors: 15, intervalMs: 140, sessionIndex: 900 });

    const curve = fatigueCurve(metrics);
    expect(curve[0]?.fromKeystrokes).toBe(0);
    expect(curve[1]?.fromKeystrokes).toBe(750);
    expect(curve[1]!.rate).toBeGreaterThan(curve[0]!.rate);
    expect(curve[1]!.meanMs).toBeGreaterThan(curve[0]!.meanMs);
  });
});

describe('dailyHistory', () => {
  test('returns one ordered point per day with a WPM figure', () => {
    const metrics = createMetrics();
    type(metrics, { expected: 'a', times: 100, errors: 10, intervalMs: 200, at: 3 * DAY });
    type(metrics, { expected: 'a', times: 100, errors: 4, intervalMs: 150, at: 4 * DAY });

    const history = dailyHistory(metrics);
    expect(history.map((d) => d.day)).toEqual([3, 4]);
    expect(history[0]?.date).toBe('1970-01-04');
    expect(history[0]?.wpm).toBeCloseTo(60, 6);
    expect(history[1]!.wpm).toBeGreaterThan(history[0]!.wpm);
    expect(history[1]!.rate).toBeLessThan(history[0]!.rate);
  });

  test('skips days with barely any typing', () => {
    const metrics = createMetrics();
    type(metrics, { expected: 'a', times: 5, at: 3 * DAY });
    expect(dailyHistory(metrics)).toEqual([]);
  });
});

describe('summarizeAccuracy', () => {
  test('reports headline accuracy and recovery cost', () => {
    const metrics = createMetrics();
    type(metrics, { expected: 'a', times: 100, errors: 5 });
    for (let i = 0; i < 5; i++) {
      recordConfusion(metrics, 'a', 's', { recoveryMs: 500, uncorrected: false });
    }
    metrics.sessions = 3;

    const summary = summarizeAccuracy(metrics);
    expect(summary.accuracy).toBeCloseTo(0.95, 6);
    expect(summary.errors).toBe(5);
    expect(summary.meanRecoveryMs).toBe(500);
    expect(summary.msLostToErrors).toBe(2500);
    expect(summary.sessions).toBe(3);
    expect(summary.distinctConfusions).toBe(1);
  });

  test('reports perfect accuracy for an untouched profile', () => {
    expect(summarizeAccuracy(createMetrics())).toMatchObject({ accuracy: 1, attempts: 0 });
  });
});
