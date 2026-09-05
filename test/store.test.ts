import { describe, expect, test } from 'bun:test';
import {
  type StoreOptions,
  applyBatch,
  applySample,
  createStore,
  estimateSize,
  mergeStores,
  pruneStore,
  readRecent,
} from '../src/core/store';
import type { NgramSample, ProfileStore } from '../src/core/types';

const OPTS: StoreOptions = { recentWindow: 4, maxGrams: 100 };

function sample(gram: string, total: number): NgramSample {
  const n = gram.length as 2 | 3 | 4;
  const step = total / (n - 1);
  return { n, gram, total, transitions: new Array(n - 1).fill(step) };
}

function seed(gram: string, totals: number[], opts = OPTS): ProfileStore {
  const store = createStore(0);
  for (const total of totals) applySample(store, sample(gram, total), opts, 1);
  return store;
}

describe('applySample', () => {
  test('accumulates exact lifetime moments', () => {
    const store = seed('pa', [100, 200, 300]);
    const record = store.grams['2:pa']!;
    expect(record.count).toBe(3);
    expect(record.sum).toBe(600);
    expect(record.min).toBe(100);
    expect(record.max).toBe(300);
    expect(store.totals.samples).toBe(3);
  });

  test('accumulates per-transition sums for a tetragram', () => {
    const store = createStore(0);
    applySample(store, { n: 4, gram: 'para', total: 280, transitions: [90, 110, 80] }, OPTS, 1);
    const record = store.grams['4:para']!;
    expect(record.tSum).toEqual([90, 110, 80]);
    expect(record.tSumSq).toEqual([8100, 12100, 6400]);
  });

  test('rounds stored durations to a tenth of a millisecond', () => {
    const store = seed('pa', [100.04, 100.06]);
    expect(store.grams['2:pa']!.recent).toEqual([100, 100.1]);
  });

  test('keys are namespaced by n-gram length', () => {
    const store = createStore(0);
    applySample(store, sample('pa', 100), OPTS, 1);
    applySample(store, sample('par', 200), OPTS, 1);
    expect(Object.keys(store.grams).sort()).toEqual(['2:pa', '3:par']);
  });
});

describe('ring buffer', () => {
  test('keeps only the most recent values once full', () => {
    const store = seed('pa', [1, 2, 3, 4, 5, 6]);
    const record = store.grams['2:pa']!;
    expect(record.recent).toHaveLength(4);
    expect([...record.recent].sort((a, b) => a - b)).toEqual([3, 4, 5, 6]);
    expect(record.count).toBe(6);
  });

  test('readRecent returns values oldest-first while filling', () => {
    const store = seed('pa', [1, 2, 3]);
    expect(readRecent(store.grams['2:pa']!)).toEqual([1, 2, 3]);
  });

  test('readRecent unwraps the buffer after it wraps', () => {
    const store = seed('pa', [1, 2, 3, 4, 5, 6]);
    expect(readRecent(store.grams['2:pa']!)).toEqual([3, 4, 5, 6]);
  });

  test('shrinking the window keeps the newest values', () => {
    const store = seed('pa', [1, 2, 3, 4]);
    applySample(store, sample('pa', 5), { ...OPTS, recentWindow: 2 }, 1);
    const record = store.grams['2:pa']!;
    expect(record.recent).toHaveLength(2);
    expect(record.recent).toContain(5);
  });

  test('a window of zero stores no samples but keeps the moments', () => {
    const store = createStore(0);
    applySample(store, sample('pa', 100), { ...OPTS, recentWindow: 0 }, 1);
    const record = store.grams['2:pa']!;
    expect(record.recent).toEqual([]);
    expect(record.count).toBe(1);
  });
});

describe('pruneStore', () => {
  test('does nothing while under the cap', () => {
    const store = seed('pa', [100]);
    expect(pruneStore(store, OPTS)).toBe(0);
  });

  test('drops the least-used n-grams down to the target', () => {
    const store = createStore(0);
    const opts: StoreOptions = { recentWindow: 4, maxGrams: 10 };
    for (let i = 0; i < 20; i++) {
      const gram = `a${String.fromCharCode(98 + i)}`;
      for (let k = 0; k <= i; k++) applySample(store, sample(gram, 100), opts, 1);
    }
    pruneStore(store, opts);
    expect(Object.keys(store.grams)).toHaveLength(9);
    // The survivors are the ones observed most often.
    const counts = Object.values(store.grams).map((r) => r.count);
    expect(Math.min(...counts)).toBe(12);
  });
});

describe('applyBatch', () => {
  test('folds samples and advances the totals', () => {
    const store = createStore(0);
    applyBatch(
      store,
      { samples: [sample('pa', 100), sample('ar', 120)], keystrokes: 4, runs: 1 },
      OPTS,
      7,
    );
    expect(store.totals).toEqual({ keystrokes: 4, runs: 1, samples: 2 });
    expect(store.updatedAt).toBe(7);
  });
});

describe('mergeStores', () => {
  test('sums moments for n-grams present on both sides', () => {
    const merged = mergeStores(seed('pa', [100, 100]), seed('pa', [200, 200]), OPTS);
    const record = merged.grams['2:pa']!;
    expect(record.count).toBe(4);
    expect(record.sum).toBe(600);
    expect(record.min).toBe(100);
    expect(record.max).toBe(200);
  });

  test('carries over n-grams that only one side has', () => {
    const merged = mergeStores(seed('pa', [100]), seed('ra', [200]), OPTS);
    expect(Object.keys(merged.grams).sort()).toEqual(['2:pa', '2:ra']);
  });

  test('keeps the merged sample window within its bound', () => {
    const merged = mergeStores(seed('pa', [1, 2, 3, 4]), seed('pa', [5, 6, 7, 8]), OPTS);
    expect(merged.grams['2:pa']!.recent.length).toBeLessThanOrEqual(OPTS.recentWindow);
  });

  test('does not mutate either input', () => {
    const a = seed('pa', [100]);
    const b = seed('pa', [200]);
    mergeStores(a, b, OPTS);
    expect(a.grams['2:pa']!.count).toBe(1);
    expect(b.grams['2:pa']!.count).toBe(1);
  });

  test('sums per-transition moments', () => {
    const a = createStore(0);
    applySample(a, { n: 3, gram: 'par', total: 200, transitions: [90, 110] }, OPTS, 1);
    const b = createStore(0);
    applySample(b, { n: 3, gram: 'par', total: 200, transitions: [10, 20] }, OPTS, 1);
    expect(mergeStores(a, b, OPTS).grams['3:par']!.tSum).toEqual([100, 130]);
  });
});

describe('estimateSize', () => {
  test('grows with the number of n-grams tracked', () => {
    const small = seed('pa', [100]);
    const large = seed('pa', [100, 200, 300, 400]);
    expect(estimateSize(large)).toBeGreaterThan(estimateSize(small));
  });
});
