import { describe, expect, test } from 'bun:test';
import {
  computeAllStats,
  computeBaseline,
  median,
  percentile,
  statsForRecord,
  summarize,
  transitionMsToWpm,
} from '../src/core/stats';
import { type StoreOptions, applySample, createStore } from '../src/core/store';
import type { NgramSample, ProfileStore } from '../src/core/types';

const OPTS: StoreOptions = { recentWindow: 64, maxGrams: 1000 };

function sample(gram: string, total: number): NgramSample {
  const n = gram.length as 2 | 3 | 4;
  const step = total / (n - 1);
  return { n, gram, total, transitions: new Array(n - 1).fill(step) };
}

function seed(entries: [gram: string, total: number, times: number][]): ProfileStore {
  const store = createStore(0);
  for (const [gram, total, times] of entries) {
    for (let i = 0; i < times; i++) applySample(store, sample(gram, total), OPTS, 1);
  }
  return store;
}

describe('percentile', () => {
  test('interpolates between neighbouring values', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0)).toBe(10);
    expect(percentile([10, 20, 30, 40], 1)).toBe(40);
  });

  test('sorts before measuring', () => {
    expect(median([30, 10, 20])).toBe(20);
  });

  test('handles degenerate inputs', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([42], 0.9)).toBe(42);
  });

  test('clamps out-of-range percentiles', () => {
    expect(percentile([10, 20], 2)).toBe(20);
    expect(percentile([10, 20], -1)).toBe(10);
  });
});

describe('computeBaseline', () => {
  test('falls back to a default when there is too little data', () => {
    const baseline = computeBaseline(seed([['pa', 100, 10]]));
    expect(baseline.reliable).toBe(false);
    expect(baseline.transitionMs).toBe(200);
  });

  test('uses the fast end of your bigrams once there is enough data', () => {
    const baseline = computeBaseline(
      seed([
        ['pa', 100, 20],
        ['ar', 150, 20],
        ['ra', 200, 20],
        ['as', 400, 20],
      ]),
    );
    expect(baseline.reliable).toBe(true);
    expect(baseline.transitionMs).toBeLessThan(baseline.medianTransitionMs);
    expect(baseline.transitionMs).toBeLessThanOrEqual(150);
  });

  test('ignores bigrams below the sample threshold', () => {
    const store = seed([
      ['pa', 100, 20],
      ['ar', 150, 20],
      ['ra', 200, 20],
      ['zz', 5, 1],
    ]);
    expect(computeBaseline(store, { minSamples: 5 }).transitionMs).toBeGreaterThan(5);
  });

  test('ignores trigrams and tetragrams', () => {
    const store = seed([
      ['pa', 100, 20],
      ['ar', 100, 20],
      ['ra', 100, 20],
      ['para', 2000, 50],
    ]);
    expect(computeBaseline(store).transitionMs).toBe(100);
  });
});

describe('statsForRecord', () => {
  const baseline = { transitionMs: 100, medianTransitionMs: 120, sampleCount: 100, reliable: true };

  test('reports median, p90 and spread', () => {
    const store = seed([['pa', 200, 1]]);
    for (const total of [100, 300, 400]) applySample(store, sample('pa', total), OPTS, 1);
    const stats = statsForRecord(store.grams['2:pa']!, baseline);
    expect(stats.count).toBe(4);
    expect(stats.median).toBe(250);
    expect(stats.min).toBe(100);
    expect(stats.max).toBe(400);
    expect(stats.sd).toBeGreaterThan(0);
    expect(stats.cv).toBeCloseTo(stats.sd / stats.mean, 10);
  });

  test('breaks a tetragram into its internal transitions', () => {
    const store = createStore(0);
    applySample(store, { n: 4, gram: 'para', total: 280, transitions: [90, 110, 80] }, OPTS, 1);
    const stats = statsForRecord(store.grams['4:para']!, baseline);
    expect(stats.transitions.map((t) => `${t.from}>${t.to}`)).toEqual(['p>a', 'a>r', 'r>a']);
    expect(stats.transitions.map((t) => t.mean)).toEqual([90, 110, 80]);
    expect(stats.transitions.reduce((acc, t) => acc + t.share, 0)).toBeCloseTo(1, 10);
  });

  test('splits accented n-grams on grapheme boundaries', () => {
    const store = createStore(0);
    applySample(store, { n: 3, gram: 'año', total: 200, transitions: [90, 110] }, OPTS, 1);
    const stats = statsForRecord(store.grams['3:año']!, baseline);
    expect(stats.transitions.map((t) => `${t.from}>${t.to}`)).toEqual(['a>ñ', 'ñ>o']);
  });

  test('divides the median by the number of transitions', () => {
    const store = seed([['para', 300, 3]]);
    expect(statsForRecord(store.grams['4:para']!, baseline).msPerTransition).toBe(100);
  });

  test('charges no excess to an n-gram at or under baseline', () => {
    const store = seed([['pa', 80, 5]]);
    const stats = statsForRecord(store.grams['2:pa']!, baseline);
    expect(stats.excessMs).toBe(0);
    expect(stats.msLost).toBe(0);
  });

  test('excess is measured against the baseline scaled by transitions', () => {
    const store = seed([['para', 500, 4]]);
    const stats = statsForRecord(store.grams['4:para']!, baseline);
    expect(stats.excessMs).toBe(200);
    expect(stats.msLost).toBe(800);
  });
});

describe('computeAllStats', () => {
  test('normalizes impact within each n-gram length', () => {
    const store = seed([
      ['pa', 100, 20],
      ['ar', 100, 20],
      ['ra', 100, 20],
      ['xz', 600, 20],
      ['para', 2000, 20],
    ]);
    const stats = computeAllStats(store, computeBaseline(store));
    const worstBigram = stats.filter((s) => s.n === 2).sort((a, b) => b.impact - a.impact)[0];
    const worstTetragram = stats.filter((s) => s.n === 4)[0];
    expect(worstBigram?.gram).toBe('xz');
    expect(worstBigram?.impact).toBe(100);
    // Tetragrams are ranked against tetragrams, not against bigrams.
    expect(worstTetragram?.impact).toBe(100);
  });

  test('a frequent mild offender can outrank a rare severe one', () => {
    const store = seed([
      ['pa', 100, 50],
      ['ar', 100, 50],
      ['ra', 100, 50],
      ['sl', 160, 200],
      ['qk', 400, 2],
    ]);
    const stats = computeAllStats(store, computeBaseline(store));
    const slow = stats.find((s) => s.gram === 'sl')!;
    const rare = stats.find((s) => s.gram === 'qk')!;
    expect(slow.median).toBeLessThan(rare.median);
    expect(slow.msLost).toBeGreaterThan(rare.msLost);
    expect(slow.impact).toBeGreaterThan(rare.impact);
  });
});

describe('summarize', () => {
  test('derives implied and ceiling WPM from bigram speed', () => {
    const store = seed([
      ['pa', 100, 20],
      ['ar', 200, 20],
      ['ra', 300, 20],
    ]);
    const baseline = computeBaseline(store);
    const summary = summarize(store, computeAllStats(store, baseline), baseline);
    expect(summary.uniqueGrams[2]).toBe(3);
    expect(summary.impliedWpm).toBeCloseTo(transitionMsToWpm(200), 6);
    expect(summary.ceilingWpm).toBeGreaterThan(summary.impliedWpm);
  });

  test('counts unique n-grams per length', () => {
    const store = seed([
      ['pa', 100, 2],
      ['par', 200, 2],
      ['para', 300, 2],
    ]);
    const baseline = computeBaseline(store);
    const summary = summarize(store, computeAllStats(store, baseline), baseline);
    expect(summary.uniqueGrams).toEqual({ 2: 1, 3: 1, 4: 1 });
  });
});

describe('transitionMsToWpm', () => {
  test('200 ms between keys is 60 WPM', () => {
    expect(transitionMsToWpm(200)).toBe(60);
  });

  test('guards against a zero interval', () => {
    expect(transitionMsToWpm(0)).toBe(0);
  });
});
