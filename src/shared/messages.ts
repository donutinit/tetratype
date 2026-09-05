import type { Metrics } from '../core/metrics';
import type { ImportMode } from '../core/serialize';
import type { Settings } from '../core/settings';
import type { NgramSample, ProfileStore } from '../core/types';

/** Storage keys owned by the extension. All data lives in `storage.local`. */
export const STORAGE_KEYS = {
  store: 'tetratype:store',
  settings: 'tetratype:settings',
  meta: 'tetratype:meta',
} as const;

/** Non-profile runtime facts, kept out of exports. */
export interface RuntimeMeta {
  /** Measured granularity of the page clock, in milliseconds. */
  timerResolutionMs: number;
  /** Epoch ms of the last keystroke folded into the profile. */
  lastCaptureAt: number;
  /** Extension version that last wrote the profile. */
  version: string;
}

export const DEFAULT_META: RuntimeMeta = {
  timerResolutionMs: 0,
  lastCaptureAt: 0,
  version: '0.0.0',
};

/** A batch of observations handed from a content script to the background. */
export interface IngestBatch {
  samples: NgramSample[];
  keystrokes: number;
  runs: number;
  timerResolutionMs: number;
  /** Accuracy counters gathered over the same window. */
  metrics: Metrics;
}

export type Message =
  | { type: 'ingest'; batch: IngestBatch }
  | { type: 'getSettings' }
  | { type: 'setSettings'; patch: Partial<Settings> }
  | { type: 'getSnapshot' }
  | { type: 'reset' }
  | { type: 'import'; text: string; mode: ImportMode };

export interface Snapshot {
  store: ProfileStore;
  settings: Settings;
  meta: RuntimeMeta;
}

export type Response =
  | { ok: true; type: 'ingest' }
  | { ok: true; type: 'settings'; settings: Settings }
  | { ok: true; type: 'snapshot'; snapshot: Snapshot }
  | { ok: true; type: 'reset' }
  | { ok: true; type: 'import'; grams: number }
  | { ok: false; error: string };

/** Message broadcast to content scripts when settings change. */
export interface SettingsChanged {
  type: 'settingsChanged';
  settings: Settings;
}
