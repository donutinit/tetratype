/**
 * Content script: runs only on Monkeytype.
 *
 * It never reads page text, never touches the network and never calls
 * `preventDefault`. All it does is time keystrokes inside the typing input,
 * turn them into n-gram statistics locally, and hand batches to the background
 * page for storage.
 */

import { isEmpty } from '../core/metrics';
import { DEFAULT_SETTINGS, type Settings, normalizeSettings } from '../core/settings';
import { probeTimerResolution } from '../core/timing';
import type { NgramSample } from '../core/types';
import { type IngestBatch, STORAGE_KEYS } from '../shared/messages';
import { onStorageChanged, readKey, runtime } from '../shared/webext';
import { Capture } from './capture';

/** How often finished observations are handed to the background page. */
const FLUSH_INTERVAL_MS = 4000;
/** Flush early rather than hold an unbounded buffer in the page. */
const MAX_BUFFERED_SAMPLES = 4000;

let settings: Settings = { ...DEFAULT_SETTINGS };
let pending: NgramSample[] = [];
let pendingKeystrokes = 0;
let pendingRuns = 0;
let timerResolutionMs = 0;

const capture = new Capture(settings, {
  onSamples: (samples, runs) => {
    pending.push(...samples);
    pendingRuns += runs;
    if (pending.length >= MAX_BUFFERED_SAMPLES) void flush();
  },
  onKeystroke: () => {
    pendingKeystrokes++;
    if (timerResolutionMs === 0) {
      // Measured once, after the first keystroke, so page load stays untouched.
      timerResolutionMs = probeTimerResolution();
    }
  },
});

async function flush(): Promise<void> {
  const metrics = capture.drainMetrics();
  const nothingToSend =
    pending.length === 0 && pendingKeystrokes === 0 && pendingRuns === 0 && isEmpty(metrics);
  if (nothingToSend) return;

  const batch: IngestBatch = {
    samples: pending,
    keystrokes: pendingKeystrokes,
    runs: pendingRuns,
    timerResolutionMs,
    metrics,
  };
  pending = [];
  pendingKeystrokes = 0;
  pendingRuns = 0;
  try {
    await runtime().sendMessage({ type: 'ingest', batch });
  } catch {
    // The background page may be starting up; the next batch carries on.
  }
}

function applySettings(next: Settings): void {
  const wasCapturing = settings.capture;
  settings = next;
  capture.updateSettings(next);
  if (wasCapturing && !next.capture) {
    capture.breakRun();
    void flush();
  }
}

function attach(): void {
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  document.addEventListener('keydown', (e) => capture.handleKeyDown(e), opts);
  document.addEventListener('beforeinput', (e) => capture.handleBeforeInput(e as InputEvent), opts);
  document.addEventListener('compositionstart', () => capture.handleCompositionStart(), opts);
  document.addEventListener(
    'compositionend',
    (e) => capture.handleCompositionEnd(e as CompositionEvent),
    opts,
  );

  // Anything that interrupts typing also ends the run.
  const interrupt = (): void => {
    capture.breakRun();
    void flush();
  };
  window.addEventListener('blur', interrupt);
  window.addEventListener('pagehide', interrupt);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') interrupt();
  });

  setInterval(() => void flush(), FLUSH_INTERVAL_MS);
}

function watchSettings(): void {
  onStorageChanged((changes) => {
    const change = changes[STORAGE_KEYS.settings];
    if (change) applySettings(normalizeSettings(change.newValue));
  });
}

async function main(): Promise<void> {
  settings = normalizeSettings(await readKey(STORAGE_KEYS.settings, DEFAULT_SETTINGS));
  capture.updateSettings(settings);
  attach();
  watchSettings();
}

void main();
