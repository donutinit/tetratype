import { type GramShape, type LayoutId, classifyGram, getLayout } from './layout';
import type { Metrics } from './metrics';
import { graphemes } from './text';
import type { NgramRecord, NgramSize, ProfileStore } from './types';

/** Statistics for one transition inside an n-gram, e.g. `p → a` of `para`. */
export interface TransitionStat {
  from: string;
  to: string;
  mean: number;
  sd: number;
  /** Share of the n-gram's total time spent on this transition, 0..1. */
  share: number;
}

/** Everything the dashboard shows for a single n-gram. */
export interface NgramStats {
  key: string;
  gram: string;
  n: NgramSize;
  count: number;
  mean: number;
  median: number;
  p90: number;
  min: number;
  max: number;
  sd: number;
  /** Coefficient of variation: how inconsistent this n-gram is. */
  cv: number;
  /** Median time divided by the number of transitions. */
  msPerTransition: number;
  /** Median time above what your baseline speed predicts, per occurrence. */
  excessMs: number;
  /** Total milliseconds this n-gram has cost you: `excessMs × count`. */
  msLost: number;
  /** `msLost` rescaled to 0..100 against the worst n-gram of the same length. */
  impact: number;
  transitions: TransitionStat[];
  updated: number;
  /** How many values back the median and p90 are computed over. */
  windowSize: number;
  /** What this n-gram asks of your hands, from the keyboard layout. */
  shape: GramShape;
  /**
   * Milliseconds this pair costs inside longer n-grams beyond what it costs
   * alone. Positive means the pair is fine but its surroundings are not.
   * Always 0 for n-grams longer than a bigram.
   */
  contextPenaltyMs: number;
  /** Fast trend mean minus slow: negative means you are speeding up. */
  trendMs: number;
  /** Chance of fumbling this n-gram somewhere, or null when untracked. */
  errorRate: number | null;
  /** Keystrokes the error rate is based on. */
  errorAttempts: number;
}

/** Your personal reference speed, derived from your own fastest bigrams. */
export interface Baseline {
  /** Per-transition milliseconds at your comfortable best (20th percentile). */
  transitionMs: number;
  /** Per-transition milliseconds at your typical speed (median). */
  medianTransitionMs: number;
  /** Bigram observations the baseline was computed from. */
  sampleCount: number;
  /** False when there is not enough data yet and defaults were used. */
  reliable: boolean;
}

export interface StatsOptions {
  /** N-grams below this many observations are ignored by the baseline. */
  minSamples: number;
  /** Keyboard the shape analysis is computed against. */
  layout?: LayoutId;
}

export const DEFAULT_STATS_OPTIONS: StatsOptions = { minSamples: 5, layout: 'qwerty-es' };

/** Mean time a pair takes when it appears inside a longer n-gram. */
export interface TransitionContext {
  inContextMs: number;
  samples: number;
}

/**
 * Measures each key pair as it behaves inside longer n-grams.
 *
 * A pair can be quick in isolation and slow once it has to be entered from the
 * middle of a word, which is a different problem from the pair itself being
 * hard. Comparing the two tells them apart.
 */
export function computeTransitionContext(store: ProfileStore): Map<string, TransitionContext> {
  const totals = new Map<string, { sum: number; count: number }>();

  for (const record of Object.values(store.grams)) {
    if (record.n < 3 || record.count === 0) continue;
    const chars = graphemes(record.gram);
    for (let i = 0; i < record.tSum.length; i++) {
      const from = chars[i];
      const to = chars[i + 1];
      if (from === undefined || to === undefined) continue;
      const key = `${from}>${to}`;
      const entry = totals.get(key) ?? { sum: 0, count: 0 };
      entry.sum += record.tSum[i] ?? 0;
      entry.count += record.count;
      totals.set(key, entry);
    }
  }

  const context = new Map<string, TransitionContext>();
  for (const [key, entry] of totals) {
    if (entry.count > 0) {
      context.set(key, { inContextMs: entry.sum / entry.count, samples: entry.count });
    }
  }
  return context;
}

/**
 * Chance of going wrong somewhere inside an n-gram.
 *
 * Combines the per-transition error rates as independent events, which is what
 * "how often do I fumble this" means in practice.
 */
export function errorRateFor(
  chars: readonly string[],
  metrics: Metrics | undefined,
): { rate: number | null; attempts: number } {
  if (!metrics || chars.length < 2) return { rate: null, attempts: 0 };

  let survival = 1;
  let attempts = Number.POSITIVE_INFINITY;
  let seen = false;

  for (let i = 1; i < chars.length; i++) {
    const record = metrics.transitions[`${chars[i - 1]}>${chars[i]}`];
    if (!record || record.attempts === 0) continue;
    seen = true;
    survival *= 1 - record.errors / record.attempts;
    attempts = Math.min(attempts, record.attempts);
  }

  if (!seen) return { rate: null, attempts: 0 };
  return { rate: 1 - survival, attempts: Number.isFinite(attempts) ? attempts : 0 };
}

/** Percentile of an unsorted numeric array, linearly interpolated. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (sorted.length - 1) * Math.min(Math.max(p, 0), 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sorted[low]!;
  if (low === high) return lowValue;
  return lowValue + (sorted[high]! - lowValue) * (rank - low);
}

export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

/** Standard deviation from stored moments, clamped against float noise. */
function sdFromMoments(count: number, sum: number, sumSq: number): number {
  if (count < 2) return 0;
  const variance = sumSq / count - (sum / count) ** 2;
  return variance > 0 ? Math.sqrt(variance) : 0;
}

/**
 * A percentile over values weighted by how often they were observed.
 *
 * Used for the baseline so a bigram you typed 500 times counts more than one
 * you typed six times.
 */
function weightedPercentile(
  entries: readonly { value: number; weight: number }[],
  p: number,
): number {
  if (entries.length === 0) return 0;
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((acc, e) => acc + e.weight, 0);
  if (totalWeight <= 0) return sorted[0]!.value;
  const cutoff = totalWeight * p;
  let running = 0;
  for (const entry of sorted) {
    running += entry.weight;
    if (running >= cutoff) return entry.value;
  }
  return sorted[sorted.length - 1]!.value;
}

/** Milliseconds per transition assumed before enough data exists. */
const FALLBACK_TRANSITION_MS = 200;

/**
 * Derives your reference speed from bigrams only.
 *
 * Bigrams are the cleanest signal: one transition each, so their durations are
 * directly comparable. The 20th percentile answers "how fast do I move between
 * keys when nothing is in the way", which is the speed the rest of the profile
 * is measured against.
 */
export function computeBaseline(
  store: ProfileStore,
  opts: StatsOptions = DEFAULT_STATS_OPTIONS,
): Baseline {
  const entries: { value: number; weight: number }[] = [];
  let sampleCount = 0;

  for (const record of Object.values(store.grams)) {
    if (record.n !== 2 || record.count < opts.minSamples) continue;
    const values = record.recent.length > 0 ? record.recent : [record.sum / record.count];
    entries.push({ value: median(values), weight: record.count });
    sampleCount += record.count;
  }

  if (entries.length < 3) {
    return {
      transitionMs: FALLBACK_TRANSITION_MS,
      medianTransitionMs: FALLBACK_TRANSITION_MS,
      sampleCount,
      reliable: false,
    };
  }

  return {
    transitionMs: weightedPercentile(entries, 0.2),
    medianTransitionMs: weightedPercentile(entries, 0.5),
    sampleCount,
    reliable: true,
  };
}

export interface RecordContext {
  layout?: LayoutId;
  transitionContext?: Map<string, TransitionContext>;
  metrics?: Metrics;
}

/** Computes derived statistics for one record. `impact` is filled in later. */
export function statsForRecord(
  record: NgramRecord,
  baseline: Baseline,
  context: RecordContext = {},
): NgramStats {
  const values = record.recent.length > 0 ? record.recent : [];
  const mean = record.count > 0 ? record.sum / record.count : 0;
  const med = values.length > 0 ? median(values) : mean;
  const p90 = values.length > 0 ? percentile(values, 0.9) : mean;
  const sd = sdFromMoments(record.count, record.sum, record.sumSq);
  const steps = record.n - 1;

  const chars = graphemes(record.gram);
  const transitions: TransitionStat[] = [];
  const transitionMeanTotal =
    record.tSum.reduce((acc, s) => acc + s, 0) / Math.max(1, record.count);

  for (let i = 0; i < steps; i++) {
    const tMean = record.count > 0 ? (record.tSum[i] ?? 0) / record.count : 0;
    transitions.push({
      from: chars[i] ?? '',
      to: chars[i + 1] ?? '',
      mean: tMean,
      sd: sdFromMoments(record.count, record.tSum[i] ?? 0, record.tSumSq[i] ?? 0),
      share: transitionMeanTotal > 0 ? tMean / transitionMeanTotal : 0,
    });
  }

  const expected = baseline.transitionMs * steps;
  const excessMs = Math.max(0, med - expected);

  const layout = getLayout(context.layout ?? 'qwerty-es');
  const shape = classifyGram(chars, layout);
  const { rate, attempts } = errorRateFor(chars, context.metrics);

  let contextPenaltyMs = 0;
  if (record.n === 2 && context.transitionContext) {
    const pair = context.transitionContext.get(`${chars[0] ?? ''}>${chars[1] ?? ''}`);
    if (pair) contextPenaltyMs = pair.inContextMs - med;
  }

  const trendMs =
    record.ewmaFast > 0 && record.ewmaSlow > 0 ? record.ewmaFast - record.ewmaSlow : 0;

  return {
    key: `${record.n}:${record.gram}`,
    gram: record.gram,
    n: record.n,
    count: record.count,
    mean,
    median: med,
    p90,
    min: Number.isFinite(record.min) ? record.min : 0,
    max: record.max,
    sd,
    cv: mean > 0 ? sd / mean : 0,
    msPerTransition: steps > 0 ? med / steps : 0,
    excessMs,
    msLost: excessMs * record.count,
    impact: 0,
    transitions,
    updated: record.updated,
    windowSize: values.length,
    shape,
    contextPenaltyMs,
    trendMs,
    errorRate: rate,
    errorAttempts: attempts,
  };
}

/**
 * Computes stats for every n-gram in the store and normalizes `impact`.
 *
 * Normalization happens per n-gram length so tetragrams, which are inherently
 * slower, do not crowd bigrams out of the impact ranking.
 */
export function computeAllStats(
  store: ProfileStore,
  baseline: Baseline,
  opts: StatsOptions = DEFAULT_STATS_OPTIONS,
): NgramStats[] {
  const context: RecordContext = {
    layout: opts.layout,
    transitionContext: computeTransitionContext(store),
    metrics: store.metrics,
  };
  const all = Object.values(store.grams)
    .filter((record) => record.count >= 1)
    .map((record) => statsForRecord(record, baseline, context));

  const worstByN = new Map<NgramSize, number>();
  for (const stat of all) {
    if (stat.count < opts.minSamples) continue;
    worstByN.set(stat.n, Math.max(worstByN.get(stat.n) ?? 0, stat.msLost));
  }
  for (const stat of all) {
    const worst = worstByN.get(stat.n) ?? 0;
    stat.impact = worst > 0 ? Math.min(100, (stat.msLost / worst) * 100) : 0;
  }
  return all;
}

/** Headline numbers for the top of the dashboard. */
export interface ProfileSummary {
  keystrokes: number;
  runs: number;
  samples: number;
  uniqueGrams: Record<NgramSize, number>;
  baseline: Baseline;
  /** WPM implied by your measured bigram speed. */
  impliedWpm: number;
  /** WPM you would reach if every bigram ran at your baseline speed. */
  ceilingWpm: number;
  /** Total milliseconds lost to slow bigrams across the whole profile. */
  totalMsLost: number;
  lastSeen: number;
}

/** Milliseconds per minute divided by the 5 characters in a standard word. */
const MS_PER_MINUTE_PER_WORD = 60000 / 5;

/** Converts an average inter-key interval into words per minute. */
export function transitionMsToWpm(ms: number): number {
  return ms > 0 ? MS_PER_MINUTE_PER_WORD / ms : 0;
}

export function summarize(
  store: ProfileStore,
  stats: readonly NgramStats[],
  baseline: Baseline,
): ProfileSummary {
  const uniqueGrams: Record<NgramSize, number> = { 2: 0, 3: 0, 4: 0 };
  let weightedTransition = 0;
  let weight = 0;
  let totalMsLost = 0;
  let lastSeen = 0;

  for (const stat of stats) {
    uniqueGrams[stat.n] += 1;
    lastSeen = Math.max(lastSeen, stat.updated);
    if (stat.n !== 2) continue;
    weightedTransition += stat.median * stat.count;
    weight += stat.count;
    totalMsLost += stat.msLost;
  }

  const meanTransition = weight > 0 ? weightedTransition / weight : 0;

  return {
    keystrokes: store.totals.keystrokes,
    runs: store.totals.runs,
    samples: store.totals.samples,
    uniqueGrams,
    baseline,
    impliedWpm: transitionMsToWpm(meanTransition),
    ceilingWpm: transitionMsToWpm(baseline.transitionMs),
    totalMsLost,
    lastSeen,
  };
}
