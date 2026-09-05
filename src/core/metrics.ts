/**
 * Accuracy and behaviour data that is not tied to a single n-gram.
 *
 * Latency answers "how fast"; this answers "how reliably, when, and instead of
 * what". Every structure here is a bounded counter map, so it stays small no
 * matter how long you use the extension, and none of it holds text longer than
 * a single character.
 */

/** A mistake: what the test asked for, and what you produced instead. */
export interface ConfusionRecord {
  expected: string;
  typed: string;
  count: number;
  /** Sum of milliseconds from the mistake to the right character landing. */
  recoveryMs: number;
  recoveryCount: number;
  /** Times the mistake was never fixed before the word ended. */
  uncorrected: number;
}

/** Keystrokes attempted against a target, and how many went wrong. */
export interface AttemptRecord {
  attempts: number;
  errors: number;
}

/** Speed and accuracy over some slice: a day, a speed band, a session stage. */
export interface PerfBucket {
  /** Inter-key intervals timed in this slice. */
  samples: number;
  /** Sum of those intervals, in milliseconds. */
  sumMs: number;
  attempts: number;
  errors: number;
}

export interface MetricsTotals {
  attempts: number;
  errors: number;
  corrected: number;
  uncorrected: number;
}

export interface Metrics {
  /** Keyed `expected>typed`. */
  confusions: Record<string, ConfusionRecord>;
  /** Keyed by the character that should have been typed. */
  chars: Record<string, AttemptRecord>;
  /** Keyed `previous>expected`, so it joins onto the bigram table. */
  transitions: Record<string, AttemptRecord>;
  /** Accuracy against how fast the keystroke arrived. Keyed by bucket index. */
  speed: Record<string, PerfBucket>;
  /** Accuracy against how far into a session you were. Keyed by bucket index. */
  fatigue: Record<string, PerfBucket>;
  /** Keyed by whole days since the epoch. */
  days: Record<string, PerfBucket>;
  sessions: number;
  totals: MetricsTotals;
}

/** Width of a speed band, in milliseconds. */
export const SPEED_BUCKET_MS = 25;
/** Bands kept, covering 0 ms up to the pause threshold. */
export const SPEED_BUCKETS = 20;
/** Keystrokes per session-progress band. */
export const FATIGUE_BUCKET_KEYS = 250;
export const FATIGUE_BUCKETS = 12;
/** Days of history retained. */
export const MAX_DAYS = 180;
/** Distinct confusion pairs retained before the rarest are dropped. */
export const MAX_CONFUSIONS = 2000;

export function createMetrics(): Metrics {
  return {
    confusions: {},
    chars: {},
    transitions: {},
    speed: {},
    fatigue: {},
    days: {},
    sessions: 0,
    totals: { attempts: 0, errors: 0, corrected: 0, uncorrected: 0 },
  };
}

export function confusionKey(expected: string, typed: string): string {
  return `${expected}>${typed}`;
}

export function speedBucket(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) return 0;
  return Math.min(SPEED_BUCKETS - 1, Math.floor(intervalMs / SPEED_BUCKET_MS));
}

export function fatigueBucket(keystrokesThisSession: number): number {
  return Math.min(FATIGUE_BUCKETS - 1, Math.floor(keystrokesThisSession / FATIGUE_BUCKET_KEYS));
}

export function dayNumber(epochMs: number): number {
  return Math.floor(epochMs / 86_400_000);
}

function bucket(map: Record<string, PerfBucket>, key: string | number): PerfBucket {
  const existing = map[String(key)];
  if (existing) return existing;
  const created: PerfBucket = { samples: 0, sumMs: 0, attempts: 0, errors: 0 };
  map[String(key)] = created;
  return created;
}

function attempt(map: Record<string, AttemptRecord>, key: string): AttemptRecord {
  const existing = map[key];
  if (existing) return existing;
  const created: AttemptRecord = { attempts: 0, errors: 0 };
  map[key] = created;
  return created;
}

/** One keystroke, as the capture layer saw it. */
export interface KeystrokeOutcome {
  /** The character the test wanted, when we could read it. */
  expected: string | null;
  /** The character actually produced. */
  typed: string;
  /** True when they differ. */
  wrong: boolean;
  /** Interval from the previous keystroke, or null if the run just started. */
  intervalMs: number | null;
  /** The character expected before this one, for the transition key. */
  previousExpected: string | null;
  /** Keystrokes already typed in this session. */
  sessionIndex: number;
  /** Wall-clock time, for the daily history. */
  at: number;
}

/** Folds one keystroke into the counters. */
export function recordKeystroke(metrics: Metrics, outcome: KeystrokeOutcome): void {
  const target = outcome.expected ?? outcome.typed;

  metrics.totals.attempts += 1;
  if (outcome.wrong) metrics.totals.errors += 1;

  const charRecord = attempt(metrics.chars, target);
  charRecord.attempts += 1;
  if (outcome.wrong) charRecord.errors += 1;

  if (outcome.previousExpected !== null) {
    const key = `${outcome.previousExpected}>${target}`;
    const transitionRecord = attempt(metrics.transitions, key);
    transitionRecord.attempts += 1;
    if (outcome.wrong) transitionRecord.errors += 1;
  }

  const day = bucket(metrics.days, dayNumber(outcome.at));
  const stage = bucket(metrics.fatigue, fatigueBucket(outcome.sessionIndex));
  for (const slice of [day, stage]) {
    slice.attempts += 1;
    if (outcome.wrong) slice.errors += 1;
  }

  if (outcome.intervalMs !== null) {
    const band = bucket(metrics.speed, speedBucket(outcome.intervalMs));
    band.attempts += 1;
    if (outcome.wrong) band.errors += 1;
    for (const slice of [day, stage, band]) {
      slice.samples += 1;
      slice.sumMs += outcome.intervalMs;
    }
  }
}

/** Records a mistake, and how it was resolved. */
export function recordConfusion(
  metrics: Metrics,
  expected: string,
  typed: string,
  resolution: { recoveryMs: number | null; uncorrected: boolean },
): void {
  const key = confusionKey(expected, typed);
  const existing = metrics.confusions[key];
  const record: ConfusionRecord = existing ?? {
    expected,
    typed,
    count: 0,
    recoveryMs: 0,
    recoveryCount: 0,
    uncorrected: 0,
  };
  record.count += 1;
  if (resolution.recoveryMs !== null && resolution.recoveryMs >= 0) {
    record.recoveryMs += resolution.recoveryMs;
    record.recoveryCount += 1;
    metrics.totals.corrected += 1;
  }
  if (resolution.uncorrected) {
    record.uncorrected += 1;
    metrics.totals.uncorrected += 1;
  }
  metrics.confusions[key] = record;
}

function mergeAttempts(
  base: Record<string, AttemptRecord>,
  delta: Record<string, AttemptRecord>,
): void {
  for (const [key, value] of Object.entries(delta)) {
    const target = attempt(base, key);
    target.attempts += value.attempts;
    target.errors += value.errors;
  }
}

function mergeBuckets(base: Record<string, PerfBucket>, delta: Record<string, PerfBucket>): void {
  for (const [key, value] of Object.entries(delta)) {
    const target = bucket(base, key);
    target.samples += value.samples;
    target.sumMs += value.sumMs;
    target.attempts += value.attempts;
    target.errors += value.errors;
  }
}

/** Drops the rarest confusions and the oldest days once the caps are passed. */
export function pruneMetrics(metrics: Metrics): void {
  const confusionKeys = Object.keys(metrics.confusions);
  if (confusionKeys.length > MAX_CONFUSIONS) {
    const ranked = confusionKeys.sort(
      (a, b) => (metrics.confusions[a]?.count ?? 0) - (metrics.confusions[b]?.count ?? 0),
    );
    for (const key of ranked.slice(0, confusionKeys.length - MAX_CONFUSIONS)) {
      delete metrics.confusions[key];
    }
  }

  const days = Object.keys(metrics.days)
    .map(Number)
    .filter((day) => Number.isFinite(day))
    .sort((a, b) => a - b);
  for (const day of days.slice(0, Math.max(0, days.length - MAX_DAYS))) {
    delete metrics.days[String(day)];
  }
}

/** Folds a batch of counters collected in a content script into the profile. */
export function mergeMetrics(base: Metrics, delta: Metrics): void {
  for (const [key, value] of Object.entries(delta.confusions)) {
    const existing = base.confusions[key];
    if (!existing) {
      base.confusions[key] = { ...value };
      continue;
    }
    existing.count += value.count;
    existing.recoveryMs += value.recoveryMs;
    existing.recoveryCount += value.recoveryCount;
    existing.uncorrected += value.uncorrected;
  }

  mergeAttempts(base.chars, delta.chars);
  mergeAttempts(base.transitions, delta.transitions);
  mergeBuckets(base.speed, delta.speed);
  mergeBuckets(base.fatigue, delta.fatigue);
  mergeBuckets(base.days, delta.days);

  base.sessions += delta.sessions;
  base.totals.attempts += delta.totals.attempts;
  base.totals.errors += delta.totals.errors;
  base.totals.corrected += delta.totals.corrected;
  base.totals.uncorrected += delta.totals.uncorrected;

  pruneMetrics(base);
}

/** True when nothing has been recorded, so the UI can stay quiet. */
export function isEmpty(metrics: Metrics): boolean {
  return metrics.totals.attempts === 0;
}
