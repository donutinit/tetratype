/**
 * Background event page: the single writer of the profile.
 *
 * Content scripts only ever hand over batches of finished observations; every
 * merge, prune and persist happens here so two Monkeytype tabs cannot clobber
 * each other with interleaved read-modify-write cycles.
 */

import { applyImport, parseExport } from '../core/serialize';
import { DEFAULT_SETTINGS, type Settings, normalizeSettings } from '../core/settings';
import { type StoreOptions, applyBatch, createStore } from '../core/store';
import type { ProfileStore } from '../core/types';
import {
  DEFAULT_META,
  type Message,
  type Response,
  type RuntimeMeta,
  STORAGE_KEYS,
  type Snapshot,
} from '../shared/messages';
import { extensionVersion, readKey, writeKey } from '../shared/webext';

/** How long writes are coalesced. Typing produces a batch every few seconds. */
const PERSIST_DEBOUNCE_MS = 2000;

let state: Snapshot | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** Serialises persistence so two flushes never overlap. */
let persistChain: Promise<void> = Promise.resolve();

function storeOptions(settings: Settings): StoreOptions {
  return { recentWindow: settings.recentWindow, maxGrams: settings.maxGrams };
}

async function load(): Promise<Snapshot> {
  if (state) return state;
  const [store, rawSettings, meta] = await Promise.all([
    readKey<ProfileStore | null>(STORAGE_KEYS.store, null),
    readKey<unknown>(STORAGE_KEYS.settings, null),
    readKey<RuntimeMeta>(STORAGE_KEYS.meta, DEFAULT_META),
  ]);
  state = {
    store: store ?? createStore(),
    settings: rawSettings ? normalizeSettings(rawSettings) : { ...DEFAULT_SETTINGS },
    meta: { ...DEFAULT_META, ...meta, version: extensionVersion() },
  };
  return state;
}

function persistNow(): Promise<void> {
  persistChain = persistChain.then(async () => {
    if (!state) return;
    await writeKey(STORAGE_KEYS.store, state.store);
    await writeKey(STORAGE_KEYS.meta, state.meta);
  });
  return persistChain;
}

function schedulePersist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

async function flushPending(): Promise<void> {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await persistNow();
}

async function handle(message: Message): Promise<Response> {
  const snapshot = await load();

  switch (message.type) {
    case 'ingest': {
      const { batch } = message;
      applyBatch(
        snapshot.store,
        { samples: batch.samples, keystrokes: batch.keystrokes, runs: batch.runs },
        storeOptions(snapshot.settings),
      );
      snapshot.meta.lastCaptureAt = Date.now();
      if (batch.timerResolutionMs > 0) {
        snapshot.meta.timerResolutionMs = batch.timerResolutionMs;
      }
      schedulePersist();
      return { ok: true, type: 'ingest' };
    }

    case 'getSettings':
      return { ok: true, type: 'settings', settings: snapshot.settings };

    case 'setSettings': {
      snapshot.settings = normalizeSettings({ ...snapshot.settings, ...message.patch });
      // Content scripts and the dashboard pick this up via storage.onChanged,
      // which keeps the manifest down to a single `storage` permission.
      await writeKey(STORAGE_KEYS.settings, snapshot.settings);
      return { ok: true, type: 'settings', settings: snapshot.settings };
    }

    case 'getSnapshot':
      await flushPending();
      return { ok: true, type: 'snapshot', snapshot };

    case 'reset': {
      snapshot.store = createStore();
      snapshot.meta = { ...DEFAULT_META, version: extensionVersion() };
      await flushPending();
      return { ok: true, type: 'reset' };
    }

    case 'import': {
      const parsed = parseExport(message.text);
      snapshot.store = applyImport(
        snapshot.store,
        parsed.store,
        message.mode,
        storeOptions(snapshot.settings),
      );
      if (parsed.settings) {
        snapshot.settings = parsed.settings;
        await writeKey(STORAGE_KEYS.settings, snapshot.settings);
      }
      await flushPending();
      return { ok: true, type: 'import', grams: Object.keys(snapshot.store.grams).length };
    }
  }
}

browser.runtime.onMessage.addListener((message: unknown): Promise<Response> | undefined => {
  if (typeof message !== 'object' || message === null || !('type' in message)) return undefined;
  return handle(message as Message).catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  }));
});

// Event pages can be suspended at any time; do not lose the pending batch.
browser.runtime.onSuspend?.addListener(() => {
  void flushPending();
});
