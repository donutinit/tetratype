import { describe, expect, test } from 'bun:test';
import { confusionRanking } from '../src/core/insights';
import { createMetrics, recordConfusion, recordKeystroke } from '../src/core/metrics';
import { buildReport } from '../src/core/report';
import { confusionsToCsv, toCsv } from '../src/core/serialize';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { computeAllStats, computeBaseline, summarize } from '../src/core/stats';
import { type StoreOptions, applySample, createStore } from '../src/core/store';
import type { NgramSample, ProfileStore } from '../src/core/types';

const OPTS: StoreOptions = { recentWindow: 40, maxGrams: 1000 };
const DAY = 86_400_000;

function sample(gram: string, total: number): NgramSample {
  const n = gram.length as 2 | 3 | 4;
  return { n, gram, total, transitions: new Array(n - 1).fill(total / (n - 1)) };
}

/** A profile with timings, mistakes, and enough history for every section. */
function seed(): ProfileStore {
  const store = createStore(0);
  const entries: [string, number, number][] = [
    ['ca', 90, 40],
    ['as', 95, 40],
    ['sa', 100, 40],
    ['br', 300, 30],
    ['cas', 190, 40],
    ['casa', 290, 40],
  ];
  for (const [gram, total, times] of entries) {
    for (let i = 0; i < times; i++) applySample(store, sample(gram, total), OPTS, 1);
  }

  const metrics = createMetrics();
  for (let day = 0; day < 3; day++) {
    for (let i = 0; i < 200; i++) {
      recordKeystroke(metrics, {
        expected: 'a',
        typed: i < 10 ? 's' : 'a',
        wrong: i < 10,
        intervalMs: i < 100 ? 40 : 180,
        previousExpected: 'c',
        sessionIndex: i * 5,
        at: (10 + day) * DAY,
      });
    }
  }
  for (let i = 0; i < 12; i++) {
    recordConfusion(metrics, 'a', 's', { recoveryMs: 500, uncorrected: false });
  }
  store.metrics = metrics;
  return store;
}

function report(store = seed(), minSamples = 5): string {
  const opts = { minSamples, layout: DEFAULT_SETTINGS.layout };
  const baseline = computeBaseline(store, opts);
  const stats = computeAllStats(store, baseline, opts);
  return buildReport({
    store,
    settings: DEFAULT_SETTINGS,
    stats,
    summary: summarize(store, stats, baseline),
    minSamples,
    now: 20 * DAY,
  });
}

describe('buildReport', () => {
  const text = report();

  test('opens with a header naming the layout and the threshold', () => {
    expect(text).toStartWith('# Tetratype analysis');
    expect(text).toContain('QWERTY (Spanish)');
    expect(text).toContain('at least 5 samples');
  });

  test('states how the numbers were measured', () => {
    expect(text).toContain('keydown to keydown');
    expect(text).toContain('20th percentile');
  });

  test('includes every section', () => {
    for (const heading of [
      '## Overview',
      '## N-grams',
      '## Mistakes',
      '## Characters most often missed',
      '## Speed against accuracy',
      '## Within a session',
      '## Day by day',
    ]) {
      expect(text).toContain(heading);
    }
  });

  test('carries the n-gram table as CSV with its header', () => {
    expect(text).toContain('```csv');
    expect(text).toContain('n,ngram,samples,median_ms');
    expect(text).toContain('shape,same_finger');
    expect(text).toContain('4,casa,');
  });

  test('carries the mistakes as their own CSV', () => {
    expect(text).toContain('expected,typed,count,share,relation');
    expect(text).toContain('a,s,12');
  });

  test('reports the accuracy cliff in words', () => {
    expect(text).toMatch(/Accuracy holds down to \*\*\d+–\d+ ms\*\*/);
  });

  test('tabulates the daily history', () => {
    expect(text).toContain('| date | keystrokes | wpm | accuracy |');
    expect(text).toContain('1970-01-11');
  });

  test('honours the sample threshold', () => {
    const store = seed();
    for (let i = 0; i < 2; i++) applySample(store, sample('zq', 400), OPTS, 1);
    expect(report(store, 5)).not.toContain('2,zq,');
    expect(report(store, 1)).toContain('2,zq,');
  });

  test('degrades gracefully on an untouched profile', () => {
    const empty = createStore(0);
    const baseline = computeBaseline(empty);
    const text = buildReport({
      store: empty,
      settings: DEFAULT_SETTINGS,
      stats: [],
      summary: summarize(empty, [], baseline),
      minSamples: 5,
    });
    expect(text).toContain('_No repeated mistakes recorded._');
    expect(text).toContain('_Not enough keystrokes yet._');
    expect(text).toContain('_Not enough days yet._');
  });
});

describe('csv exports', () => {
  const store = seed();
  const opts = { minSamples: 5, layout: DEFAULT_SETTINGS.layout };
  const stats = computeAllStats(store, computeBaseline(store, opts), opts);

  test('the n-gram csv carries the shape and accuracy columns', () => {
    const header = toCsv(stats).split('\n')[0] ?? '';
    for (const column of [
      'shape',
      'same_finger',
      'row_jump',
      'dead_keys',
      'miss_rate',
      'trend_ms',
      'context_ms',
    ]) {
      expect(header).toContain(column);
    }
  });

  test('names the physical shape of each n-gram', () => {
    const rows = toCsv(stats).split('\n');
    const br = rows.find((row) => row.startsWith('2,br,'));
    // `b` and `r` are both left index: a same-finger bigram.
    expect(br).toContain('same finger');
  });

  test('leaves the miss rate blank when it was never measured', () => {
    const bare = createStore(0);
    for (let i = 0; i < 10; i++) applySample(bare, sample('qq', 100), OPTS, 1);
    const bareStats = computeAllStats(bare, computeBaseline(bare, opts), opts);
    const row = toCsv(bareStats).split('\n')[1] ?? '';
    expect(row.split(',')).toContain('');
  });

  test('the confusion csv escapes a comma typed by mistake', () => {
    const metrics = createMetrics();
    for (let i = 0; i < 3; i++) {
      recordConfusion(metrics, ',', 'm', { recoveryMs: 100, uncorrected: false });
    }
    const csv = confusionsToCsv(confusionRanking(metrics));
    expect(csv).toContain('","');
  });

  test('the confusion csv is just a header when there is nothing to report', () => {
    expect(confusionsToCsv([]).trim().split('\n')).toHaveLength(1);
  });
});
