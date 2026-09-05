/**
 * Views over the accuracy counters.
 *
 * Each of these turns one of the bounded counter maps into an ordered series
 * the dashboard can draw and a language model can read, without any of them
 * needing to know how the counters are stored.
 */

import { type LayoutId, type TransitionShape, classifyTransition, getLayout } from './layout';
import { FATIGUE_BUCKET_KEYS, type Metrics, SPEED_BUCKET_MS } from './metrics';

/** A mistake you make often enough to be worth naming. */
export interface ConfusionStat {
  expected: string;
  typed: string;
  count: number;
  /** Share of all your mistakes, 0..1. */
  share: number;
  /** Mean milliseconds from the slip to the right character landing. */
  meanRecoveryMs: number;
  uncorrected: number;
  /** Total time this single confusion has cost, including the fixing. */
  msLost: number;
  /** What the two characters have in common physically, if anything. */
  relation: TransitionShape | 'unrelated';
}

/**
 * Explains a mistake in terms of the keyboard.
 *
 * Substituting a letter for its neighbour on the same finger is a different
 * problem from substituting the mirrored key on the other hand, and the layout
 * is what tells them apart.
 */
function relate(expected: string, typed: string, layout: LayoutId): ConfusionStat['relation'] {
  const analysis = classifyTransition(expected, typed, getLayout(layout));
  if (analysis.shape === 'unknown') return 'unrelated';
  return analysis.shape;
}

export interface InsightOptions {
  layout?: LayoutId;
  /** Confusions seen fewer times than this are left out. */
  minCount?: number;
}

export function confusionRanking(metrics: Metrics, opts: InsightOptions = {}): ConfusionStat[] {
  const layout = opts.layout ?? 'qwerty-es';
  const minCount = opts.minCount ?? 2;
  const totalErrors = Math.max(1, metrics.totals.errors);

  return Object.values(metrics.confusions)
    .filter((record) => record.count >= minCount)
    .map((record) => {
      const meanRecoveryMs =
        record.recoveryCount > 0 ? record.recoveryMs / record.recoveryCount : 0;
      return {
        expected: record.expected,
        typed: record.typed,
        count: record.count,
        share: record.count / totalErrors,
        meanRecoveryMs,
        uncorrected: record.uncorrected,
        msLost: record.recoveryMs,
        relation: relate(record.expected, record.typed, layout),
      };
    })
    .sort((a, b) => b.msLost - a.msLost || b.count - a.count);
}

/** How often you miss a given character, regardless of what you typed instead. */
export interface CharAccuracy {
  char: string;
  attempts: number;
  errors: number;
  rate: number;
}

export function charAccuracy(metrics: Metrics, minAttempts = 20): CharAccuracy[] {
  return Object.entries(metrics.chars)
    .filter(([, record]) => record.attempts >= minAttempts)
    .map(([char, record]) => ({
      char,
      attempts: record.attempts,
      errors: record.errors,
      rate: record.errors / record.attempts,
    }))
    .sort((a, b) => b.rate - a.rate);
}

/** One band of the speed/accuracy trade-off. */
export interface SpeedAccuracyPoint {
  fromMs: number;
  toMs: number;
  attempts: number;
  errors: number;
  rate: number;
}

export function speedAccuracyCurve(metrics: Metrics, minAttempts = 30): SpeedAccuracyPoint[] {
  return Object.entries(metrics.speed)
    .map(([key, record]) => {
      const index = Number(key);
      return {
        fromMs: index * SPEED_BUCKET_MS,
        toMs: (index + 1) * SPEED_BUCKET_MS,
        attempts: record.attempts,
        errors: record.errors,
        rate: record.attempts > 0 ? record.errors / record.attempts : 0,
      };
    })
    .filter((point) => Number.isFinite(point.fromMs) && point.attempts >= minAttempts)
    .sort((a, b) => a.fromMs - b.fromMs);
}

/**
 * The fastest band you can still hold accuracy in.
 *
 * Reading down from the slow end, this is where your error rate first crosses
 * the threshold — in other words, how hard you can push before you start
 * paying for it.
 */
export function accuracyCliff(
  curve: readonly SpeedAccuracyPoint[],
  threshold = 0.05,
): SpeedAccuracyPoint | null {
  const ordered = [...curve].sort((a, b) => b.fromMs - a.fromMs);
  let last: SpeedAccuracyPoint | null = null;
  for (const point of ordered) {
    if (point.rate > threshold) return last;
    last = point;
  }
  return last;
}

/** Speed and accuracy against how long you have been typing. */
export interface FatiguePoint {
  fromKeystrokes: number;
  toKeystrokes: number;
  attempts: number;
  errors: number;
  rate: number;
  meanMs: number;
}

export function fatigueCurve(metrics: Metrics, minAttempts = 50): FatiguePoint[] {
  return Object.entries(metrics.fatigue)
    .map(([key, record]) => {
      const index = Number(key);
      return {
        fromKeystrokes: index * FATIGUE_BUCKET_KEYS,
        toKeystrokes: (index + 1) * FATIGUE_BUCKET_KEYS,
        attempts: record.attempts,
        errors: record.errors,
        rate: record.attempts > 0 ? record.errors / record.attempts : 0,
        meanMs: record.samples > 0 ? record.sumMs / record.samples : 0,
      };
    })
    .filter((point) => Number.isFinite(point.fromKeystrokes) && point.attempts >= minAttempts)
    .sort((a, b) => a.fromKeystrokes - b.fromKeystrokes);
}

/** One day of typing. */
export interface DayPoint {
  day: number;
  date: string;
  attempts: number;
  errors: number;
  rate: number;
  meanMs: number;
  wpm: number;
}

const MS_PER_MINUTE_PER_WORD = 60000 / 5;

export function dailyHistory(metrics: Metrics, minAttempts = 50): DayPoint[] {
  return Object.entries(metrics.days)
    .map(([key, record]) => {
      const day = Number(key);
      const meanMs = record.samples > 0 ? record.sumMs / record.samples : 0;
      return {
        day,
        date: new Date(day * 86_400_000).toISOString().slice(0, 10),
        attempts: record.attempts,
        errors: record.errors,
        rate: record.attempts > 0 ? record.errors / record.attempts : 0,
        meanMs,
        wpm: meanMs > 0 ? MS_PER_MINUTE_PER_WORD / meanMs : 0,
      };
    })
    .filter((point) => Number.isFinite(point.day) && point.attempts >= minAttempts)
    .sort((a, b) => a.day - b.day);
}

/** Headline accuracy numbers. */
export interface AccuracySummary {
  attempts: number;
  errors: number;
  /** Correct keystrokes as a fraction, 0..1. */
  accuracy: number;
  corrected: number;
  uncorrected: number;
  /** Mean milliseconds spent recovering from one mistake. */
  meanRecoveryMs: number;
  /** Total milliseconds spent fixing mistakes. */
  msLostToErrors: number;
  sessions: number;
  distinctConfusions: number;
}

export function summarizeAccuracy(metrics: Metrics): AccuracySummary {
  let recoveryMs = 0;
  let recoveryCount = 0;
  for (const record of Object.values(metrics.confusions)) {
    recoveryMs += record.recoveryMs;
    recoveryCount += record.recoveryCount;
  }

  const attempts = metrics.totals.attempts;
  return {
    attempts,
    errors: metrics.totals.errors,
    accuracy: attempts > 0 ? 1 - metrics.totals.errors / attempts : 1,
    corrected: metrics.totals.corrected,
    uncorrected: metrics.totals.uncorrected,
    meanRecoveryMs: recoveryCount > 0 ? recoveryMs / recoveryCount : 0,
    msLostToErrors: recoveryMs,
    sessions: metrics.sessions,
    distinctConfusions: Object.keys(metrics.confusions).length,
  };
}
