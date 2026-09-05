/** User-tunable behaviour, persisted alongside the profile. */
export interface Settings {
  /** Master switch for the capture layer. */
  capture: boolean;
  /** A gap longer than this ends the current run (ms). */
  breakOnPauseMs: number;
  /** Treat spaces as ordinary characters instead of run delimiters. */
  includeSpaces: boolean;
  /** Break the run when Monkeytype marks a character as incorrect. */
  detectErrors: boolean;
  /** Ring-buffer size per n-gram, used for median and p90. */
  recentWindow: number;
  /** Cap on distinct n-grams retained. */
  maxGrams: number;
  /** Minimum observations before an n-gram is considered trustworthy. */
  minSamples: number;
}

export const DEFAULT_SETTINGS: Settings = {
  capture: true,
  breakOnPauseMs: 1000,
  includeSpaces: false,
  detectErrors: true,
  recentWindow: 64,
  maxGrams: 20000,
  minSamples: 5,
};

interface Bounds {
  min: number;
  max: number;
}

const BOUNDS: Record<'breakOnPauseMs' | 'recentWindow' | 'maxGrams' | 'minSamples', Bounds> = {
  breakOnPauseMs: { min: 200, max: 10000 },
  recentWindow: { min: 8, max: 512 },
  maxGrams: { min: 500, max: 200000 },
  minSamples: { min: 1, max: 1000 },
};

function clampInt(value: unknown, bounds: Bounds, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(num)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Coerces arbitrary input into valid settings, falling back per field. */
export function normalizeSettings(input: unknown): Settings {
  const raw = (input ?? {}) as Partial<Record<keyof Settings, unknown>>;
  return {
    capture: bool(raw.capture, DEFAULT_SETTINGS.capture),
    includeSpaces: bool(raw.includeSpaces, DEFAULT_SETTINGS.includeSpaces),
    detectErrors: bool(raw.detectErrors, DEFAULT_SETTINGS.detectErrors),
    breakOnPauseMs: clampInt(
      raw.breakOnPauseMs,
      BOUNDS.breakOnPauseMs,
      DEFAULT_SETTINGS.breakOnPauseMs,
    ),
    recentWindow: clampInt(raw.recentWindow, BOUNDS.recentWindow, DEFAULT_SETTINGS.recentWindow),
    maxGrams: clampInt(raw.maxGrams, BOUNDS.maxGrams, DEFAULT_SETTINGS.maxGrams),
    minSamples: clampInt(raw.minSamples, BOUNDS.minSamples, DEFAULT_SETTINGS.minSamples),
  };
}
