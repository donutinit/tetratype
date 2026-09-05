import type { Metrics } from './metrics';

/**
 * Core domain types for Tetratype.
 *
 * Everything in `src/core` is pure and browser-free so it can be unit tested
 * without a DOM or a WebExtension runtime.
 */

/** N-gram lengths Tetratype tracks. */
export type NgramSize = 2 | 3 | 4;

export const NGRAM_SIZES: readonly NgramSize[] = [2, 3, 4] as const;

/** The smallest unit we capture: one produced grapheme and when it landed. */
export interface Keystroke {
  /** A single NFC-normalized grapheme, e.g. `a`, `ñ`, `á`. */
  char: string;
  /** Monotonic timestamp in milliseconds (`event.timeStamp`). */
  t: number;
}

/** Why a run of consecutive keystrokes was closed. */
export type BreakReason =
  | 'space'
  | 'backspace'
  | 'pause'
  | 'error'
  | 'blur'
  | 'nontext'
  | 'overflow'
  | 'flush';

/** One clean observation of an n-gram, extracted from an uninterrupted run. */
export interface NgramSample {
  n: NgramSize;
  /** The literal characters, e.g. `par`. */
  gram: string;
  /** Milliseconds from the first to the last keystroke of the n-gram. */
  total: number;
  /** The `n - 1` inter-key intervals in milliseconds. */
  transitions: number[];
}

/**
 * Bounded, mergeable statistics for a single n-gram.
 *
 * Raw events are never persisted. Lifetime moments (`count`/`sum`/`sumSq`) give
 * exact mean, variance and extremes in O(1) space, while `recent` keeps a small
 * ring buffer of the latest durations so quantiles reflect current form rather
 * than form from six months ago.
 */
export interface NgramRecord {
  gram: string;
  n: NgramSize;
  /** Lifetime number of observations. */
  count: number;
  /** Sum of total durations (ms). */
  sum: number;
  /** Sum of squared total durations, for variance. */
  sumSq: number;
  min: number;
  max: number;
  /** Per-position lifetime sums of transition times; length `n - 1`. */
  tSum: number[];
  /** Per-position lifetime sums of squares; length `n - 1`. */
  tSumSq: number[];
  /** Ring buffer of the most recent total durations, rounded to 0.1 ms. */
  recent: number[];
  /**
   * Two exponentially weighted means of the total duration.
   *
   * The fast one follows recent form, the slow one holds your longer-run
   * average. Their difference is a trend that costs two numbers instead of a
   * stored time series.
   */
  ewmaFast: number;
  ewmaSlow: number;
  /** Write cursor into `recent`, used once the buffer is full. */
  cursor: number;
  /** Epoch milliseconds of the most recent observation. */
  updated: number;
}

/** Everything Tetratype persists about your typing. */
export interface ProfileStore {
  /** Schema version, bumped on breaking layout changes. */
  version: number;
  createdAt: number;
  updatedAt: number;
  totals: ProfileTotals;
  /** Keyed by `${n}:${gram}`. */
  grams: Record<string, NgramRecord>;
  /** Accuracy and behaviour counters that are not per-n-gram. */
  metrics: Metrics;
}

export interface ProfileTotals {
  /** Keystrokes seen by the capture layer. */
  keystrokes: number;
  /** Uninterrupted runs committed. */
  runs: number;
  /** N-gram observations folded into `grams`. */
  samples: number;
}

/**
 * The current schema version of {@link ProfileStore}.
 *
 * 2 added the accuracy metrics block and the per-n-gram trend means. Version 1
 * profiles import cleanly: the missing fields take their zero values.
 */
export const STORE_VERSION = 2;
