import type { ConfusionStat } from './insights';
import {
  type AttemptRecord,
  type Metrics,
  type PerfBucket,
  confusionKey,
  createMetrics,
  pruneMetrics,
} from './metrics';
import { type Settings, normalizeSettings } from './settings';
import type { NgramStats } from './stats';
import { DEFAULT_STORE_OPTIONS, type StoreOptions, createStore, mergeStores } from './store';
import { type NgramRecord, type NgramSize, type ProfileStore, STORE_VERSION } from './types';

/** Marker so an imported file can be recognised as ours before parsing. */
export const EXPORT_FORMAT = 'tetratype-profile';

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: number;
  settings: Settings;
  store: ProfileStore;
}

export function buildExport(store: ProfileStore, settings: Settings, now = Date.now()): ExportFile {
  return {
    format: EXPORT_FORMAT,
    version: STORE_VERSION,
    exportedAt: now,
    settings,
    store,
  };
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numberArray(value: unknown, length: number): number[] {
  const out = new Array<number>(length).fill(0);
  if (!Array.isArray(value)) return out;
  for (let i = 0; i < length; i++) {
    out[i] = numberOr(value[i], 0);
  }
  return out;
}

function parseRecord(key: string, value: unknown): NgramRecord | null {
  if (!isRecord(value)) return null;
  const parsedN = Number(value.n);
  if (parsedN !== 2 && parsedN !== 3 && parsedN !== 4) return null;
  const n = parsedN as NgramSize;
  const gram = typeof value.gram === 'string' ? value.gram : key.slice(key.indexOf(':') + 1);
  if (gram.length === 0) return null;

  const count = Math.max(0, Math.round(numberOr(value.count, 0)));
  const recent = Array.isArray(value.recent)
    ? value.recent.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    : [];

  return {
    gram,
    n,
    count,
    sum: numberOr(value.sum, 0),
    sumSq: numberOr(value.sumSq, 0),
    min: numberOr(value.min, Number.POSITIVE_INFINITY),
    max: numberOr(value.max, 0),
    tSum: numberArray(value.tSum, n - 1),
    tSumSq: numberArray(value.tSumSq, n - 1),
    recent,
    cursor: Math.max(0, Math.round(numberOr(value.cursor, 0))),
    ewmaFast: numberOr(value.ewmaFast, 0),
    ewmaSlow: numberOr(value.ewmaSlow, 0),
    updated: numberOr(value.updated, 0),
  };
}

function parseAttempts(input: unknown): Record<string, AttemptRecord> {
  const out: Record<string, AttemptRecord> = {};
  if (!isRecord(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    if (!isRecord(value)) continue;
    out[key] = {
      attempts: Math.max(0, Math.round(numberOr(value.attempts, 0))),
      errors: Math.max(0, Math.round(numberOr(value.errors, 0))),
    };
  }
  return out;
}

function parseBuckets(input: unknown): Record<string, PerfBucket> {
  const out: Record<string, PerfBucket> = {};
  if (!isRecord(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    if (!isRecord(value)) continue;
    out[key] = {
      samples: Math.max(0, Math.round(numberOr(value.samples, 0))),
      sumMs: Math.max(0, numberOr(value.sumMs, 0)),
      attempts: Math.max(0, Math.round(numberOr(value.attempts, 0))),
      errors: Math.max(0, Math.round(numberOr(value.errors, 0))),
    };
  }
  return out;
}

/**
 * Reads the accuracy block, tolerating its complete absence.
 *
 * Version 1 profiles have no metrics at all, so importing one simply yields
 * empty counters rather than failing.
 */
export function parseMetrics(input: unknown): Metrics {
  const metrics = createMetrics();
  if (!isRecord(input)) return metrics;

  if (isRecord(input.confusions)) {
    for (const [key, value] of Object.entries(input.confusions)) {
      if (!isRecord(value)) continue;
      const expected =
        typeof value.expected === 'string' ? value.expected : (key.split('>')[0] ?? '');
      const typed = typeof value.typed === 'string' ? value.typed : (key.split('>')[1] ?? '');
      if (expected === '' || typed === '') continue;
      metrics.confusions[confusionKey(expected, typed)] = {
        expected,
        typed,
        count: Math.max(0, Math.round(numberOr(value.count, 0))),
        recoveryMs: Math.max(0, numberOr(value.recoveryMs, 0)),
        recoveryCount: Math.max(0, Math.round(numberOr(value.recoveryCount, 0))),
        uncorrected: Math.max(0, Math.round(numberOr(value.uncorrected, 0))),
      };
    }
  }

  metrics.chars = parseAttempts(input.chars);
  metrics.transitions = parseAttempts(input.transitions);
  metrics.speed = parseBuckets(input.speed);
  metrics.fatigue = parseBuckets(input.fatigue);
  metrics.days = parseBuckets(input.days);
  metrics.sessions = Math.max(0, Math.round(numberOr(input.sessions, 0)));

  const totals = isRecord(input.totals) ? input.totals : {};
  metrics.totals = {
    attempts: Math.max(0, Math.round(numberOr(totals.attempts, 0))),
    errors: Math.max(0, Math.round(numberOr(totals.errors, 0))),
    corrected: Math.max(0, Math.round(numberOr(totals.corrected, 0))),
    uncorrected: Math.max(0, Math.round(numberOr(totals.uncorrected, 0))),
  };

  pruneMetrics(metrics);
  return metrics;
}

/** Parses and sanitises a store, dropping anything malformed rather than throwing. */
export function parseStore(input: unknown): ProfileStore {
  if (!isRecord(input)) throw new ImportError('Profile data is not an object.');
  const grams = isRecord(input.grams) ? input.grams : {};
  const totals = isRecord(input.totals) ? input.totals : {};
  const store = createStore(numberOr(input.createdAt, Date.now()));

  store.updatedAt = numberOr(input.updatedAt, store.createdAt);
  store.totals = {
    keystrokes: Math.max(0, Math.round(numberOr(totals.keystrokes, 0))),
    runs: Math.max(0, Math.round(numberOr(totals.runs, 0))),
    samples: Math.max(0, Math.round(numberOr(totals.samples, 0))),
  };

  for (const [key, value] of Object.entries(grams)) {
    const record = parseRecord(key, value);
    if (record) store.grams[`${record.n}:${record.gram}`] = record;
  }
  store.metrics = parseMetrics(input.metrics);
  return store;
}

export interface ParsedImport {
  store: ProfileStore;
  settings: Settings | null;
}

/** Reads an exported file, accepting either the wrapper or a bare store. */
export function parseExport(text: string): ParsedImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError('File is not valid JSON.');
  }
  if (!isRecord(parsed)) throw new ImportError('File is not a Tetratype export.');

  if (parsed.format === EXPORT_FORMAT) {
    const version = numberOr(parsed.version, 0);
    if (version > STORE_VERSION) {
      throw new ImportError(
        `Export is version ${version}; this build understands up to ${STORE_VERSION}.`,
      );
    }
    return {
      store: parseStore(parsed.store),
      settings: parsed.settings ? normalizeSettings(parsed.settings) : null,
    };
  }

  if (isRecord(parsed.grams)) return { store: parseStore(parsed), settings: null };
  throw new ImportError('File is not a Tetratype export.');
}

export type ImportMode = 'merge' | 'replace';

export function applyImport(
  current: ProfileStore,
  incoming: ProfileStore,
  mode: ImportMode,
  opts: StoreOptions = DEFAULT_STORE_OPTIONS,
): ProfileStore {
  return mode === 'replace' ? incoming : mergeStores(current, incoming, opts);
}

const CSV_COLUMNS = [
  'n',
  'ngram',
  'samples',
  'median_ms',
  'mean_ms',
  'p90_ms',
  'min_ms',
  'max_ms',
  'sd_ms',
  'cv',
  'ms_per_transition',
  'excess_ms',
  'ms_lost',
  'impact',
  'shape',
  'same_finger',
  'row_jump',
  'dead_keys',
  'miss_rate',
  'miss_attempts',
  'trend_ms',
  'context_ms',
  'transitions',
  'last_seen',
] as const;

/** Quotes a CSV field, escaping embedded quotes per RFC 4180. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function fixed(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0';
}

const CONFUSION_COLUMNS = [
  'expected',
  'typed',
  'count',
  'share',
  'relation',
  'mean_recovery_ms',
  'ms_lost',
  'uncorrected',
] as const;

/** Exports the mistakes table, for analysis alongside the timings. */
export function confusionsToCsv(rows: readonly ConfusionStat[]): string {
  const lines = [CONFUSION_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(
      [
        csvField(row.expected),
        csvField(row.typed),
        String(row.count),
        fixed(row.share, 4),
        csvField(row.relation),
        fixed(row.meanRecoveryMs),
        fixed(row.msLost, 0),
        String(row.uncorrected),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Renders per-transition means as `p>a:95.10|a>r:110.23`. */
function transitionsField(stat: NgramStats): string {
  return stat.transitions.map((t) => `${t.from}>${t.to}:${fixed(t.mean)}`).join('|');
}

export function toCsv(stats: readonly NgramStats[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const stat of stats) {
    lines.push(
      [
        String(stat.n),
        csvField(stat.gram),
        String(stat.count),
        fixed(stat.median),
        fixed(stat.mean),
        fixed(stat.p90),
        fixed(stat.min),
        fixed(stat.max),
        fixed(stat.sd),
        fixed(stat.cv, 3),
        fixed(stat.msPerTransition),
        fixed(stat.excessMs),
        fixed(stat.msLost, 0),
        fixed(stat.impact, 1),
        csvField(stat.shape.label),
        String(stat.shape.sameFingerCount),
        String(stat.shape.maxRowJump),
        String(stat.shape.deadKeyCount),
        stat.errorRate === null ? '' : fixed(stat.errorRate, 4),
        String(stat.errorAttempts),
        fixed(stat.trendMs, 1),
        fixed(stat.contextPenaltyMs, 1),
        csvField(transitionsField(stat)),
        new Date(stat.updated).toISOString(),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
