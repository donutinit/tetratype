import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { applySample, createStore } from '../src/core/store';
import type { NgramSample, ProfileStore } from '../src/core/types';
import { STORAGE_KEYS } from '../src/shared/messages';

const OPTS = { recentWindow: 40, maxGrams: 12000 };
const sent: unknown[] = [];
const stored: Record<string, unknown> = {};

function sample(gram: string, total: number): NgramSample {
  const n = gram.length as 2 | 3 | 4;
  return { n, gram, total, transitions: new Array(n - 1).fill(total / (n - 1)) };
}

/** A profile with a clear fast/slow split so rankings are predictable. */
function seedStore(): ProfileStore {
  const store = createStore(0);
  const entries: [string, number, number][] = [
    ['ca', 90, 40],
    ['as', 95, 40],
    ['sa', 100, 40],
    ['br', 260, 30],
    ['qu', 120, 25],
    ['cas', 190, 40],
    ['asa', 200, 40],
    ['casa', 290, 40],
    ['bra', 400, 30],
    ['brav', 620, 30],
    ['año', 300, 12],
  ];
  for (const [gram, total, times] of entries) {
    for (let i = 0; i < times; i++)
      applySample(store, sample(gram, total), OPTS, 1_700_000_000_000);
  }
  store.totals = { keystrokes: 5000, runs: 900, samples: 337 };
  return store;
}

/** Mounts the real dashboard markup and a minimal extension runtime. */
function mountDashboard(): void {
  const html = readFileSync(join(import.meta.dir, '../src/dashboard/index.html'), 'utf8');
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');

  stored[STORAGE_KEYS.store] = seedStore();
  stored[STORAGE_KEYS.settings] = DEFAULT_SETTINGS;
  stored[STORAGE_KEYS.meta] = {
    timerResolutionMs: 1,
    lastCaptureAt: Date.now() - 30_000,
    version: '0.1.0',
  };

  (globalThis as Record<string, unknown>).browser = {
    storage: {
      local: {
        get: async (key: string) => (key in stored ? { [key]: stored[key] } : {}),
        set: async (patch: Record<string, unknown>) => {
          Object.assign(stored, patch);
        },
      },
      onChanged: { addListener: () => {} },
    },
    runtime: {
      sendMessage: async (message: unknown) => {
        sent.push(message);
        return { ok: true, type: 'settings', settings: DEFAULT_SETTINGS };
      },
      getManifest: () => ({ version: '0.1.0' }),
      getURL: (path: string) => path,
    },
  };
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const rows = () => [...document.querySelectorAll<HTMLElement>('#body tr[data-key]')];
const gramCells = () =>
  rows().map((r) => r.querySelector('td')?.textContent?.replace('▸', '') ?? '');

/** Waits for the dashboard's async load to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(async () => {
  mountDashboard();
  await import('../src/dashboard/main');
  await settle();
});

describe('dashboard rendering', () => {
  test('fills in the summary cards', () => {
    const labels = [...$('cards').querySelectorAll('.card-label')].map((el) => el.textContent);
    expect(labels).toContain('Implied WPM');
    expect(labels).toContain('Baseline');
    expect(labels).toContain('Keystrokes');
    expect($('cards').textContent).toContain('5,000');
  });

  test('renders every top list', () => {
    for (const id of ['top-slow', 'top-erratic', 'top-impact']) {
      expect($(id).querySelectorAll('li').length).toBeGreaterThan(0);
    }
    // `br` is both the slowest bigram and the most costly one.
    expect($('top-slow').textContent).toContain('br');
    expect($('top-impact').textContent).toContain('br');
  });

  test('shows bigrams first, sorted by impact', () => {
    expect(rows().length).toBeGreaterThan(0);
    expect(gramCells()[0]).toBe('br');
    expect(rows().every((r) => (r.dataset.key ?? '').startsWith('2:'))).toBe(true);
  });

  test('hides the timer warning when the clock is fine', () => {
    expect($('timer-warning').hidden).toBe(true);
  });

  test('renders a header cell for every column', () => {
    expect($('head-row').querySelectorAll('th').length).toBe(10);
    expect($('head-row').textContent).toContain('Impact');
  });
});

describe('dashboard interaction', () => {
  test('switching tabs shows trigrams', () => {
    ($('tabs').querySelector('[data-n="3"]') as HTMLElement).click();
    expect(rows().every((r) => (r.dataset.key ?? '').startsWith('3:'))).toBe(true);
    expect(gramCells()).toContain('cas');
  });

  test('switching to tetragrams shows four-character n-grams', () => {
    ($('tabs').querySelector('[data-n="4"]') as HTMLElement).click();
    expect(gramCells().sort()).toEqual(['brav', 'casa'].sort());
  });

  test('expanding a row reveals its internal transitions', () => {
    const target = rows().find((r) => r.dataset.key === '4:casa') as HTMLElement;
    target.click();
    const detail = document.querySelector('.detail');
    expect(detail).not.toBeNull();
    expect(detail?.textContent).toContain('c → a');
    expect(detail?.textContent).toContain('a → s');
    expect(detail?.textContent).toContain('s → a');
    expect(detail?.querySelectorAll('.transition-bar > span').length).toBe(3);
  });

  test('clicking the row again collapses it', () => {
    (rows().find((r) => r.dataset.key === '4:casa') as HTMLElement).click();
    expect(document.querySelector('.detail')).toBeNull();
  });

  test('sorting by a column reorders the table', () => {
    ($('tabs').querySelector('[data-n="2"]') as HTMLElement).click();
    // The header row is re-rendered on every sort, so re-query before clicking.
    const sortByMedian = () =>
      ($('head-row').querySelector('[data-key="median"]') as HTMLElement).click();

    sortByMedian();
    expect(gramCells()[0]).toBe('br');
    sortByMedian();
    expect(gramCells()[0]).toBe('ca');
  });

  test('the contains filter narrows the table', () => {
    const filter = $('filter-text') as HTMLInputElement;
    filter.value = 'a';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    expect(gramCells().every((g) => g.includes('a'))).toBe(true);
    expect(gramCells()).not.toContain('br');

    filter.value = '';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    expect(gramCells()).toContain('br');
  });

  test('the minimum-samples filter hides thin data', () => {
    const min = $('filter-min') as HTMLInputElement;
    min.value = '35';
    min.dispatchEvent(new Event('input', { bubbles: true }));
    expect(gramCells()).not.toContain('qu');
    expect(gramCells()).toContain('ca');

    min.value = '5';
    min.dispatchEvent(new Event('input', { bubbles: true }));
  });

  test('an empty result explains itself', () => {
    const filter = $('filter-text') as HTMLInputElement;
    filter.value = 'zzzz';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    expect(rows()).toHaveLength(0);
    expect($('empty').hidden).toBe(false);
    expect($('empty').textContent).toContain('No n-grams match');

    filter.value = '';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
  });

  test('the pause button asks the background to stop capture', async () => {
    sent.length = 0;
    $('toggle-capture').click();
    await settle();
    expect(sent).toContainEqual({ type: 'setSettings', patch: { capture: false } });
  });

  test('changing a setting sends a patch', async () => {
    sent.length = 0;
    const input = $('settings').querySelector(
      '[data-setting="breakOnPauseMs"]',
    ) as HTMLInputElement;
    input.value = '750';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(sent).toContainEqual({ type: 'setSettings', patch: { breakOnPauseMs: 750 } });
  });
});
