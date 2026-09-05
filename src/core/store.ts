import { createMetrics, mergeMetrics } from './metrics';
import type { Metrics } from './metrics';
import { gramKey } from './ngram';
import {
  type NgramRecord,
  type NgramSample,
  type NgramSize,
  type ProfileStore,
  STORE_VERSION,
} from './types';

export interface StoreOptions {
  /** Size of the per-n-gram ring buffer used for quantiles. */
  recentWindow: number;
  /** Cap on distinct n-grams kept; the least useful are pruned past it. */
  maxGrams: number;
}

export const DEFAULT_STORE_OPTIONS: StoreOptions = {
  recentWindow: 40,
  maxGrams: 12000,
};

/** Fraction of `maxGrams` we prune down to, so pruning is not run every write. */
const PRUNE_TARGET = 0.9;

/** Rounds to 0.1 ms: finer resolution than any keyboard, far smaller as JSON. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function createStore(now = Date.now()): ProfileStore {
  return {
    version: STORE_VERSION,
    createdAt: now,
    updatedAt: now,
    totals: { keystrokes: 0, runs: 0, samples: 0 },
    grams: {},
    metrics: createMetrics(),
  };
}

function createRecord(gram: string, n: NgramSize, now: number): NgramRecord {
  return {
    gram,
    n,
    count: 0,
    sum: 0,
    sumSq: 0,
    min: Number.POSITIVE_INFINITY,
    max: 0,
    tSum: new Array<number>(n - 1).fill(0),
    tSumSq: new Array<number>(n - 1).fill(0),
    recent: [],
    cursor: 0,
    ewmaFast: 0,
    ewmaSlow: 0,
    updated: now,
  };
}

/**
 * How much of a new observation each trend mean absorbs.
 *
 * The fast mean turns over in roughly a dozen repetitions, the slow one in a
 * few hundred, so the gap between them shows which direction you are moving.
 */
const EWMA_FAST = 0.2;
const EWMA_SLOW = 0.03;

function updateTrend(record: NgramRecord, value: number): void {
  record.ewmaFast =
    record.ewmaFast === 0 ? value : record.ewmaFast + EWMA_FAST * (value - record.ewmaFast);
  record.ewmaSlow =
    record.ewmaSlow === 0 ? value : record.ewmaSlow + EWMA_SLOW * (value - record.ewmaSlow);
}

/** Appends to a ring buffer, overwriting the oldest entry once it is full. */
function pushRecent(record: NgramRecord, value: number, window: number): void {
  if (window <= 0) {
    record.recent = [];
    record.cursor = 0;
    return;
  }
  if (record.recent.length > window) {
    // The window shrank in settings: keep the newest values.
    record.recent = record.recent.slice(-window);
    record.cursor = 0;
  }
  if (record.recent.length < window) {
    record.recent.push(value);
    record.cursor = record.recent.length % window;
  } else {
    record.recent[record.cursor % window] = value;
    record.cursor = (record.cursor + 1) % window;
  }
}

/**
 * Reads a ring buffer oldest-first.
 *
 * While the buffer is still filling, `cursor` sits past the last element and the
 * values are already in order. Once it wraps, `cursor` points at the oldest
 * value, so the two halves swap.
 */
export function readRecent(record: Pick<NgramRecord, 'recent' | 'cursor'>): number[] {
  const { recent, cursor } = record;
  if (recent.length === 0) return [];
  if (cursor === 0 || cursor >= recent.length) return [...recent];
  return [...recent.slice(cursor), ...recent.slice(0, cursor)];
}

/** Folds one observation into a record, in constant space. */
export function applySample(
  store: ProfileStore,
  sample: NgramSample,
  opts: StoreOptions = DEFAULT_STORE_OPTIONS,
  now = Date.now(),
): void {
  const key = gramKey(sample.n, sample.gram);
  let record = store.grams[key];
  if (!record) {
    record = createRecord(sample.gram, sample.n, now);
    store.grams[key] = record;
  }

  const total = round1(sample.total);
  record.count += 1;
  record.sum += total;
  record.sumSq += total * total;
  if (total < record.min) record.min = total;
  if (total > record.max) record.max = total;
  record.updated = now;

  for (let i = 0; i < record.tSum.length; i++) {
    const value = round1(sample.transitions[i] ?? 0);
    record.tSum[i] = (record.tSum[i] ?? 0) + value;
    record.tSumSq[i] = (record.tSumSq[i] ?? 0) + value * value;
  }

  updateTrend(record, total);
  pushRecent(record, total, opts.recentWindow);
  store.totals.samples += 1;
}

export interface ApplyBatch {
  samples: NgramSample[];
  keystrokes?: number;
  runs?: number;
  /** Accuracy counters gathered alongside the timings. */
  metrics?: Metrics;
}

/** Folds a batch of observations and prunes if the store outgrew its cap. */
export function applyBatch(
  store: ProfileStore,
  batch: ApplyBatch,
  opts: StoreOptions = DEFAULT_STORE_OPTIONS,
  now = Date.now(),
): void {
  for (const sample of batch.samples) {
    applySample(store, sample, opts, now);
  }
  if (batch.metrics) mergeMetrics(store.metrics, batch.metrics);
  store.totals.keystrokes += batch.keystrokes ?? 0;
  store.totals.runs += batch.runs ?? 0;
  store.updatedAt = now;
  pruneStore(store, opts);
}

/**
 * Drops the least informative n-grams once the cap is exceeded.
 *
 * Value is `count` first (rare combinations tell you little) and recency
 * second, so a rehearsed sequence you stopped practising outlives noise.
 */
export function pruneStore(
  store: ProfileStore,
  opts: StoreOptions = DEFAULT_STORE_OPTIONS,
): number {
  const keys = Object.keys(store.grams);
  if (keys.length <= opts.maxGrams) return 0;

  const target = Math.max(1, Math.floor(opts.maxGrams * PRUNE_TARGET));
  const ranked = keys.sort((a, b) => {
    const ra = store.grams[a]!;
    const rb = store.grams[b]!;
    return ra.count - rb.count || ra.updated - rb.updated;
  });

  const dropCount = keys.length - target;
  for (let i = 0; i < dropCount; i++) {
    delete store.grams[ranked[i]!];
  }
  return dropCount;
}

/** Averages two trend means, ignoring one that was never seeded. */
function blendTrend(a: number, b: number): number {
  if (a === 0) return b;
  if (b === 0) return a;
  return (a + b) / 2;
}

/** Merges `incoming` into `base`, summing moments and interleaving samples. */
export function mergeStores(
  base: ProfileStore,
  incoming: ProfileStore,
  opts: StoreOptions = DEFAULT_STORE_OPTIONS,
): ProfileStore {
  const merged: ProfileStore = {
    version: STORE_VERSION,
    createdAt: Math.min(base.createdAt, incoming.createdAt),
    updatedAt: Math.max(base.updatedAt, incoming.updatedAt),
    totals: {
      keystrokes: base.totals.keystrokes + incoming.totals.keystrokes,
      runs: base.totals.runs + incoming.totals.runs,
      samples: base.totals.samples + incoming.totals.samples,
    },
    grams: {},
    metrics: createMetrics(),
  };

  mergeMetrics(merged.metrics, base.metrics);
  mergeMetrics(merged.metrics, incoming.metrics);

  for (const [key, record] of Object.entries(base.grams)) {
    merged.grams[key] = {
      ...record,
      tSum: [...record.tSum],
      tSumSq: [...record.tSumSq],
      recent: [...record.recent],
    };
  }

  for (const [key, incomingRecord] of Object.entries(incoming.grams)) {
    const existing = merged.grams[key];
    if (!existing) {
      merged.grams[key] = {
        ...incomingRecord,
        tSum: [...incomingRecord.tSum],
        tSumSq: [...incomingRecord.tSumSq],
        recent: [...incomingRecord.recent],
      };
      continue;
    }
    existing.count += incomingRecord.count;
    existing.sum += incomingRecord.sum;
    existing.sumSq += incomingRecord.sumSq;
    existing.min = Math.min(existing.min, incomingRecord.min);
    existing.max = Math.max(existing.max, incomingRecord.max);
    existing.updated = Math.max(existing.updated, incomingRecord.updated);
    existing.ewmaFast = blendTrend(existing.ewmaFast, incomingRecord.ewmaFast);
    existing.ewmaSlow = blendTrend(existing.ewmaSlow, incomingRecord.ewmaSlow);
    for (let i = 0; i < existing.tSum.length; i++) {
      existing.tSum[i] = (existing.tSum[i] ?? 0) + (incomingRecord.tSum[i] ?? 0);
      existing.tSumSq[i] = (existing.tSumSq[i] ?? 0) + (incomingRecord.tSumSq[i] ?? 0);
    }
    // Keep the newest half of each side so the window stays representative.
    const half = Math.ceil(opts.recentWindow / 2);
    existing.recent = [
      ...readRecent(existing).slice(-half),
      ...readRecent(incomingRecord).slice(-half),
    ].slice(-opts.recentWindow);
    existing.cursor = existing.recent.length % Math.max(1, opts.recentWindow);
  }

  pruneStore(merged, opts);
  return merged;
}

/** Approximate persisted size in bytes, shown in the dashboard. */
export function estimateSize(store: ProfileStore): number {
  return JSON.stringify(store).length;
}
