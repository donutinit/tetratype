/** Toolbar popup: capture state, a glance at the numbers, and a way in. */

import { DEFAULT_SETTINGS, type Settings, normalizeSettings } from '../core/settings';
import { computeAllStats, computeBaseline, summarize } from '../core/stats';
import { createStore } from '../core/store';
import type { ProfileStore } from '../core/types';
import { ago, int } from '../dashboard/format';
import { DEFAULT_META, type Message, type RuntimeMeta, STORAGE_KEYS } from '../shared/messages';
import { readKey, runtime } from '../shared/webext';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let settings: Settings = { ...DEFAULT_SETTINGS };

function renderToggle(): void {
  $('toggle').textContent = settings.capture ? 'Pause' : 'Resume';
  const status = $('status');
  status.textContent = settings.capture ? 'capturing' : 'paused';
  status.className = `status ${settings.capture ? 'on' : 'off'}`;
}

function renderStats(rows: [string, string, boolean?][]): void {
  $('stats').innerHTML = rows
    .map(
      ([label, value, accent]) =>
        `<dt>${label}</dt><dd${accent ? ' class="accent"' : ''}>${value}</dd>`,
    )
    .join('');
}

async function refresh(): Promise<void> {
  const [rawStore, rawSettings, meta] = await Promise.all([
    readKey<ProfileStore | null>(STORAGE_KEYS.store, null),
    readKey<unknown>(STORAGE_KEYS.settings, null),
    readKey<RuntimeMeta>(STORAGE_KEYS.meta, DEFAULT_META),
  ]);

  const store = rawStore ?? createStore();
  settings = rawSettings ? normalizeSettings(rawSettings) : { ...DEFAULT_SETTINGS };

  const baseline = computeBaseline(store, { minSamples: settings.minSamples });
  const summary = summarize(store, computeAllStats(store, baseline), baseline);

  renderToggle();
  renderStats([
    ['Implied WPM', summary.impliedWpm > 0 ? summary.impliedWpm.toFixed(1) : '—', true],
    ['Baseline', `${baseline.transitionMs.toFixed(0)} ms`],
    ['Keystrokes', int(summary.keystrokes)],
    ['N-grams', int(summary.uniqueGrams[2] + summary.uniqueGrams[3] + summary.uniqueGrams[4])],
    ['Last capture', ago(meta.lastCaptureAt)],
  ]);
}

$('toggle').addEventListener('click', () => {
  const message: Message = { type: 'setSettings', patch: { capture: !settings.capture } };
  void runtime()
    .sendMessage(message)
    .then(() => refresh());
});

$('open').addEventListener('click', () => {
  void browser.runtime.openOptionsPage().then(() => window.close());
});

void refresh();
