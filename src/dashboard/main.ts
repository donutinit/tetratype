/**
 * Dashboard.
 *
 * Reads the profile straight from `storage.local` and recomputes derived
 * statistics in the page; the background page stays the only writer, so the
 * dashboard simply re-renders whenever storage changes.
 */

import { type ImportMode, buildExport, toCsv } from '../core/serialize';
import { DEFAULT_SETTINGS, type Settings, normalizeSettings } from '../core/settings';
import {
  type NgramStats,
  type ProfileSummary,
  computeAllStats,
  computeBaseline,
  summarize,
} from '../core/stats';
import { createStore, estimateSize } from '../core/store';
import { COARSE_TIMER_MS, isCoarse } from '../core/timing';
import type { NgramSize, ProfileStore } from '../core/types';
import {
  DEFAULT_META,
  type Message,
  type Response,
  type RuntimeMeta,
  STORAGE_KEYS,
  type Snapshot,
} from '../shared/messages';
import { onStorageChanged, readKey, runtime } from '../shared/webext';
import { ago, bytes, int, ms, seconds } from './format';
import { COLUMNS, type SortKey, compare, escapeHtml, renderDetail } from './table';

/** Rows rendered at once. Beyond this the table stops being readable anyway. */
const MAX_ROWS = 300;
const TOP_LIST_SIZE = 6;
const THEME_KEY = 'tetratype:theme';

interface View {
  n: NgramSize;
  sortKey: SortKey;
  descending: boolean;
  text: string;
  minSamples: number;
  expanded: string | null;
}

const view: View = {
  n: 2,
  sortKey: 'impact',
  descending: true,
  text: '',
  minSamples: DEFAULT_SETTINGS.minSamples,
  expanded: null,
};

let store: ProfileStore = createStore();
let settings: Settings = { ...DEFAULT_SETTINGS };
let meta: RuntimeMeta = { ...DEFAULT_META };
let stats: NgramStats[] = [];
let summary: ProfileSummary | null = null;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/* ---------------------------------------------------------------- data --- */

async function send(message: Message): Promise<Response> {
  return (await runtime().sendMessage(message)) as Response;
}

/** Asks the background page for state it has not persisted yet. */
async function requestSnapshot(): Promise<Snapshot | null> {
  try {
    const response = await send({ type: 'getSnapshot' });
    return response.ok && response.type === 'snapshot' ? response.snapshot : null;
  } catch {
    return null;
  }
}

/** Reads the profile straight out of storage, if the background is asleep. */
async function loadFromStorage(): Promise<void> {
  const [rawStore, rawSettings, rawMeta] = await Promise.all([
    readKey<ProfileStore | null>(STORAGE_KEYS.store, null),
    readKey<unknown>(STORAGE_KEYS.settings, null),
    readKey<RuntimeMeta>(STORAGE_KEYS.meta, DEFAULT_META),
  ]);
  store = rawStore ?? createStore();
  settings = rawSettings ? normalizeSettings(rawSettings) : { ...DEFAULT_SETTINGS };
  meta = { ...DEFAULT_META, ...rawMeta };
}

/**
 * Loads the profile.
 *
 * The background page is asked first because that makes it flush whatever is
 * still buffered, so opening the dashboard right after a test includes those
 * last few seconds instead of waiting for the next debounced write.
 */
async function load(): Promise<void> {
  const snapshot = await requestSnapshot();
  if (snapshot) {
    store = snapshot.store;
    settings = normalizeSettings(snapshot.settings);
    meta = { ...DEFAULT_META, ...snapshot.meta };
  } else {
    await loadFromStorage();
  }
  recompute();
}

function recompute(): void {
  const baseline = computeBaseline(store, { minSamples: settings.minSamples });
  stats = computeAllStats(store, baseline, { minSamples: settings.minSamples });
  summary = summarize(store, stats, baseline);
}

/* ------------------------------------------------------------- notices --- */

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function notify(text: string, kind: 'info' | 'error' = 'info'): void {
  const el = $('notice');
  el.textContent = text;
  el.className = kind === 'error' ? 'notice notice-error' : 'notice';
  el.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    el.hidden = true;
  }, 6000);
}

function renderTimerWarning(): void {
  const el = $('timer-warning');
  if (!isCoarse(meta.timerResolutionMs)) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = [
    `<strong>Clock resolution is ${ms(meta.timerResolutionMs, 1)} ms.</strong>`,
    "Anti-fingerprinting is rounding this page's timers, so keystroke intervals",
    `cannot be measured below ${COARSE_TIMER_MS} ms of granularity. In LibreWolf, or with`,
    '<code>privacy.resistFingerprinting</code> enabled, set',
    '<code>privacy.resistFingerprinting.reduceTimerPrecision.microseconds</code> to',
    '<code>1000</code> in <code>about:config</code>, then reload Monkeytype.',
  ].join(' ');
}

/* --------------------------------------------------------------- cards --- */

interface Card {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  accent?: boolean;
}

function buildCards(s: ProfileSummary): Card[] {
  const sizeBytes = estimateSize(store);
  return [
    {
      label: 'Implied WPM',
      value: s.impliedWpm > 0 ? s.impliedWpm.toFixed(1) : '—',
      sub: 'from your measured bigram speed',
      accent: true,
    },
    {
      label: 'Ceiling WPM',
      value: s.ceilingWpm > 0 ? s.ceilingWpm.toFixed(1) : '—',
      sub: 'if every bigram hit your baseline',
    },
    {
      label: 'Baseline',
      value: ms(s.baseline.transitionMs, 1),
      unit: 'ms',
      sub: s.baseline.reliable ? 'per transition, 20th pct' : 'not enough data yet',
    },
    {
      label: 'Time lost',
      value: seconds(s.totalMsLost),
      sub: 'across all bigrams so far',
    },
    { label: 'Keystrokes', value: int(s.keystrokes), sub: `${int(s.runs)} clean runs` },
    {
      label: 'N-grams',
      value: int(s.uniqueGrams[2] + s.uniqueGrams[3] + s.uniqueGrams[4]),
      sub: `${int(s.uniqueGrams[2])} / ${int(s.uniqueGrams[3])} / ${int(s.uniqueGrams[4])} by length`,
    },
    { label: 'Observations', value: int(s.samples), sub: `${bytes(sizeBytes)} stored` },
    {
      label: 'Last capture',
      value: ago(meta.lastCaptureAt),
      sub: settings.capture ? 'capture is on' : 'capture is paused',
    },
  ];
}

function renderCards(): void {
  if (!summary) return;
  $('cards').innerHTML = buildCards(summary)
    .map(
      (card) => `<div class="card${card.accent ? ' card-accent' : ''}">
        <div class="card-label">${escapeHtml(card.label)}</div>
        <div class="card-value">${escapeHtml(card.value)}${
          card.unit ? `<span class="unit">${escapeHtml(card.unit)}</span>` : ''
        }</div>
        ${card.sub ? `<div class="card-sub">${escapeHtml(card.sub)}</div>` : ''}
      </div>`,
    )
    .join('');
}

/* ----------------------------------------------------------- top lists --- */

function trustworthy(): NgramStats[] {
  return stats.filter((s) => s.count >= settings.minSamples);
}

function renderTopList(id: string, rows: NgramStats[], describe: (s: NgramStats) => string): void {
  const el = $(id);
  if (rows.length === 0) {
    el.innerHTML = `<li class="muted">Not enough data yet</li>`;
    return;
  }
  el.innerHTML = rows
    .map(
      (s) => `<li>
        <span class="gram">${escapeHtml(s.gram)}</span>
        <span class="meta">${escapeHtml(describe(s))}</span>
      </li>`,
    )
    .join('');
}

function renderInsights(): void {
  const pool = trustworthy();
  const byN = pool.filter((s) => s.n === view.n);
  const source = byN.length > 0 ? byN : pool;

  renderTopList(
    'top-slow',
    [...source].sort((a, b) => b.msPerTransition - a.msPerTransition).slice(0, TOP_LIST_SIZE),
    (s) => `${ms(s.msPerTransition, 1)} ms/step · ${s.count}×`,
  );
  renderTopList(
    'top-erratic',
    [...source].sort((a, b) => b.cv - a.cv).slice(0, TOP_LIST_SIZE),
    (s) => `cv ${s.cv.toFixed(2)} · ${ms(s.median)}→${ms(s.p90)} ms`,
  );
  renderTopList(
    'top-impact',
    [...source].sort((a, b) => b.msLost - a.msLost).slice(0, TOP_LIST_SIZE),
    (s) => `${seconds(s.msLost)} lost · ${s.count}×`,
  );
}

/* --------------------------------------------------------------- table --- */

function visibleRows(): NgramStats[] {
  const needle = view.text.trim().toLowerCase();
  return stats
    .filter((s) => s.n === view.n)
    .filter((s) => s.count >= view.minSamples)
    .filter((s) => needle === '' || s.gram.toLowerCase().includes(needle))
    .sort((a, b) => compare(a, b, view.sortKey, view.descending));
}

function renderHead(): void {
  $('head-row').innerHTML = COLUMNS.map((col) => {
    const sorted = col.key === view.sortKey;
    const arrow = sorted ? (view.descending ? '▼' : '▲') : '';
    return `<th data-key="${col.key}" class="${sorted ? 'is-sorted' : ''}" title="${escapeHtml(
      col.title,
    )}" scope="col">${escapeHtml(col.label)}<span class="arrow">${arrow}</span></th>`;
  }).join('');
}

function renderBody(): void {
  const rows = visibleRows();
  const shown = rows.slice(0, MAX_ROWS);
  const body = $('body');
  const empty = $('empty');

  $('row-count').textContent =
    rows.length === 0
      ? ''
      : `${int(shown.length)} of ${int(rows.length)} shown${
          rows.length > MAX_ROWS ? ' — narrow the filter to see more' : ''
        }`;

  if (shown.length === 0) {
    body.innerHTML = '';
    empty.hidden = false;
    empty.textContent =
      store.totals.samples === 0
        ? 'No data yet. Open monkeytype.com and type — results appear here within a few seconds.'
        : 'No n-grams match these filters.';
    return;
  }

  empty.hidden = true;
  body.innerHTML = shown
    .map((stat) => {
      const open = view.expanded === stat.key;
      const cells = COLUMNS.map(
        (col) => `<td class="${col.key === 'gram' ? 'gram' : ''}">${col.render(stat)}</td>`,
      ).join('');
      const main = `<tr data-key="${escapeHtml(stat.key)}" class="${open ? 'is-open' : ''}">${cells}</tr>`;
      return open ? main + renderDetail(stat, COLUMNS.length) : main;
    })
    .join('');
}

/* ------------------------------------------------------------ settings --- */

interface SettingControl {
  key: keyof Settings;
  label: string;
  help: string;
  input: string;
}

function settingControls(): SettingControl[] {
  return [
    {
      key: 'breakOnPauseMs',
      label: 'Pause threshold',
      help: 'A gap longer than this ends the run, so thinking time is never timed.',
      input: `<input type="number" min="200" max="10000" step="50" value="${settings.breakOnPauseMs}" data-setting="breakOnPauseMs" /> ms`,
    },
    {
      key: 'minSamples',
      label: 'Minimum samples',
      help: 'How many observations an n-gram needs before it is trusted.',
      input: `<input type="number" min="1" max="1000" value="${settings.minSamples}" data-setting="minSamples" />`,
    },
    {
      key: 'recentWindow',
      label: 'Sample window',
      help: 'Recent durations kept per n-gram for the median and p90.',
      input: `<input type="number" min="8" max="512" value="${settings.recentWindow}" data-setting="recentWindow" />`,
    },
    {
      key: 'maxGrams',
      label: 'N-gram cap',
      help: 'Least-used n-grams are pruned past this to bound storage.',
      input: `<input type="number" min="500" max="200000" step="500" value="${settings.maxGrams}" data-setting="maxGrams" />`,
    },
    {
      key: 'includeSpaces',
      label: 'Include spaces',
      help: 'Off by default, so n-grams stay inside a single word.',
      input: `<input type="checkbox" data-setting="includeSpaces" ${settings.includeSpaces ? 'checked' : ''} />`,
    },
    {
      key: 'detectErrors',
      label: 'Drop mistyped keys',
      help: 'Discards a keystroke Monkeytype flags as wrong, plus its hesitation.',
      input: `<input type="checkbox" data-setting="detectErrors" ${settings.detectErrors ? 'checked' : ''} />`,
    },
  ];
}

function renderSettings(): void {
  $('settings').innerHTML = settingControls()
    .map(
      (control) => `<div class="setting">
        <div class="setting-row">${control.input}<label>${escapeHtml(control.label)}</label></div>
        <p>${escapeHtml(control.help)}</p>
      </div>`,
    )
    .join('');
}

function renderCaptureButton(): void {
  const button = $<HTMLButtonElement>('toggle-capture');
  button.textContent = settings.capture ? 'Pause capture' : 'Resume capture';
  button.setAttribute('aria-pressed', String(!settings.capture));
}

function render(): void {
  renderTimerWarning();
  renderCards();
  renderInsights();
  renderHead();
  renderBody();
  renderSettings();
  renderCaptureButton();
}

/* ------------------------------------------------------------- actions --- */

function download(filename: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

async function patchSettings(patch: Partial<Settings>): Promise<void> {
  const response = await send({ type: 'setSettings', patch });
  if (response.ok && response.type === 'settings') {
    settings = response.settings;
    recompute();
    render();
  } else if (!response.ok) {
    notify(response.error, 'error');
  }
}

async function importFile(file: File, mode: ImportMode): Promise<void> {
  const response = await send({ type: 'import', text: await file.text(), mode });
  if (response.ok && response.type === 'import') {
    notify(`Imported. Profile now holds ${int(response.grams)} n-grams.`);
    await load();
    render();
  } else if (!response.ok) {
    notify(response.error, 'error');
  }
}

function applyTheme(theme: string | null): void {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function wire(): void {
  $('toggle-capture').addEventListener('click', () => {
    void patchSettings({ capture: !settings.capture });
  });

  $('export-json').addEventListener('click', () => {
    download(
      `tetratype-${stamp()}.json`,
      JSON.stringify(buildExport(store, settings), null, 2),
      'application/json',
    );
  });

  $('export-csv').addEventListener('click', () => {
    const rows = stats.filter((s) => s.count >= view.minSamples);
    download(`tetratype-${stamp()}.csv`, toCsv(rows), 'text/csv');
  });

  $('import').addEventListener('click', () => $<HTMLInputElement>('import-file').click());

  $('import-file').addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const mode: ImportMode = confirm(
      'Merge with the current profile?\n\nOK merges the two, Cancel replaces everything with the file.',
    )
      ? 'merge'
      : 'replace';
    void importFile(file, mode);
  });

  $('reset').addEventListener('click', () => {
    if (!confirm('Delete all captured typing data? This cannot be undone.')) return;
    void send({ type: 'reset' }).then(async () => {
      await load();
      render();
      notify('Profile cleared.');
    });
  });

  $('theme').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme;
    const next = current === 'dark' ? 'light' : current === 'light' ? null : 'dark';
    applyTheme(next);
    if (next) localStorage.setItem(THEME_KEY, next);
    else localStorage.removeItem(THEME_KEY);
  });

  $('tabs').addEventListener('click', (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>('.tab');
    if (!tab?.dataset.n) return;
    view.n = Number(tab.dataset.n) as NgramSize;
    view.expanded = null;
    for (const el of document.querySelectorAll('.tab')) el.classList.remove('is-active');
    tab.classList.add('is-active');
    renderInsights();
    renderBody();
  });

  $('head-row').addEventListener('click', (event) => {
    const key = (event.target as HTMLElement).closest('th')?.dataset.key as SortKey | undefined;
    if (!key) return;
    if (view.sortKey === key) {
      view.descending = !view.descending;
    } else {
      view.sortKey = key;
      view.descending = COLUMNS.find((c) => c.key === key)?.defaultDescending ?? true;
    }
    renderHead();
    renderBody();
  });

  $('body').addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('tr[data-key]');
    if (!row?.dataset.key) return;
    view.expanded = view.expanded === row.dataset.key ? null : row.dataset.key;
    renderBody();
  });

  $('filter-text').addEventListener('input', (event) => {
    view.text = (event.target as HTMLInputElement).value;
    renderBody();
  });

  $('filter-min').addEventListener('input', (event) => {
    view.minSamples = Math.max(1, Number((event.target as HTMLInputElement).value) || 1);
    renderBody();
  });

  $('settings').addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    const key = input.dataset.setting as keyof Settings | undefined;
    if (!key) return;
    const value = input.type === 'checkbox' ? input.checked : Number(input.value);
    void patchSettings({ [key]: value } as Partial<Settings>);
  });

  onStorageChanged((changes) => {
    if (
      !changes[STORAGE_KEYS.store] &&
      !changes[STORAGE_KEYS.meta] &&
      !changes[STORAGE_KEYS.settings]
    ) {
      return;
    }
    void load().then(render);
  });
}

async function main(): Promise<void> {
  applyTheme(localStorage.getItem(THEME_KEY));
  await load();
  view.minSamples = settings.minSamples;
  $<HTMLInputElement>('filter-min').value = String(view.minSamples);
  wire();
  render();
}

void main();
