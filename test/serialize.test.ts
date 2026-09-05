import { describe, expect, test } from 'bun:test';
import {
  EXPORT_FORMAT,
  ImportError,
  applyImport,
  buildExport,
  parseExport,
  parseStore,
  toCsv,
} from '../src/core/serialize';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { computeAllStats, computeBaseline } from '../src/core/stats';
import { type StoreOptions, applySample, createStore } from '../src/core/store';
import type { NgramSample, ProfileStore } from '../src/core/types';

const OPTS: StoreOptions = { recentWindow: 8, maxGrams: 100 };

function sample(gram: string, total: number): NgramSample {
  const n = gram.length as 2 | 3 | 4;
  return { n, gram, total, transitions: new Array(n - 1).fill(total / (n - 1)) };
}

function seed(entries: [string, number, number][]): ProfileStore {
  const store = createStore(0);
  for (const [gram, total, times] of entries) {
    for (let i = 0; i < times; i++) applySample(store, sample(gram, total), OPTS, 1);
  }
  return store;
}

describe('export and import round trip', () => {
  test('a profile survives a JSON round trip unchanged', () => {
    const store = seed([
      ['pa', 100, 3],
      ['para', 400, 2],
    ]);
    const text = JSON.stringify(buildExport(store, DEFAULT_SETTINGS, 123));
    const parsed = parseExport(text);
    expect(parsed.store.grams).toEqual(store.grams);
    expect(parsed.store.totals).toEqual(store.totals);
    expect(parsed.settings).toEqual(DEFAULT_SETTINGS);
  });

  test('accented n-grams survive the round trip', () => {
    const store = seed([['año', 200, 2]]);
    const parsed = parseExport(JSON.stringify(buildExport(store, DEFAULT_SETTINGS)));
    expect(Object.keys(parsed.store.grams)).toEqual(['3:año']);
  });

  test('the export is tagged so it can be recognised', () => {
    expect(buildExport(createStore(0), DEFAULT_SETTINGS).format).toBe(EXPORT_FORMAT);
  });

  test('a bare store without the wrapper is accepted', () => {
    const store = seed([['pa', 100, 1]]);
    const parsed = parseExport(JSON.stringify(store));
    expect(parsed.store.grams['2:pa']?.count).toBe(1);
    expect(parsed.settings).toBeNull();
  });
});

describe('parseExport rejections', () => {
  test('rejects text that is not JSON', () => {
    expect(() => parseExport('not json')).toThrow(ImportError);
  });

  test('rejects JSON that is not a Tetratype export', () => {
    expect(() => parseExport('{"hello":"world"}')).toThrow(/not a Tetratype export/);
  });

  test('rejects a JSON array', () => {
    expect(() => parseExport('[1,2,3]')).toThrow(ImportError);
  });

  test('rejects an export from a newer schema version', () => {
    const text = JSON.stringify({ format: EXPORT_FORMAT, version: 99, store: createStore(0) });
    expect(() => parseExport(text)).toThrow(/version 99/);
  });
});

describe('parseStore sanitising', () => {
  test('drops records with an unsupported n-gram length', () => {
    const store = parseStore({
      grams: {
        '5:abcde': { n: 5, gram: 'abcde', count: 3 },
        '2:pa': { n: 2, gram: 'pa', count: 3 },
      },
    });
    expect(Object.keys(store.grams)).toEqual(['2:pa']);
  });

  test('repairs missing numeric fields instead of throwing', () => {
    const store = parseStore({ grams: { '3:par': { n: 3, gram: 'par' } } });
    const record = store.grams['3:par']!;
    expect(record.count).toBe(0);
    expect(record.tSum).toEqual([0, 0]);
    expect(record.tSumSq).toEqual([0, 0]);
  });

  test('pads a truncated transition array to the right length', () => {
    const store = parseStore({ grams: { '4:para': { n: 4, gram: 'para', tSum: [10] } } });
    expect(store.grams['4:para']!.tSum).toEqual([10, 0, 0]);
  });

  test('discards non-numeric entries in the sample window', () => {
    const store = parseStore({
      grams: { '2:pa': { n: 2, gram: 'pa', recent: [10, 'x', null, 20, Number.NaN] } },
    });
    expect(store.grams['2:pa']!.recent).toEqual([10, 20]);
  });

  test('rejects a payload that is not an object', () => {
    expect(() => parseStore('nope')).toThrow(ImportError);
  });
});

describe('applyImport', () => {
  test('replace discards the current profile', () => {
    const result = applyImport(seed([['pa', 100, 5]]), seed([['ra', 200, 1]]), 'replace', OPTS);
    expect(Object.keys(result.grams)).toEqual(['2:ra']);
  });

  test('merge combines both profiles', () => {
    const result = applyImport(seed([['pa', 100, 5]]), seed([['pa', 200, 3]]), 'merge', OPTS);
    expect(result.grams['2:pa']!.count).toBe(8);
  });
});

describe('toCsv', () => {
  const store = seed([
    ['pa', 100, 10],
    ['ar', 150, 10],
    ['ra', 200, 10],
    ['para', 500, 10],
  ]);
  const stats = computeAllStats(store, computeBaseline(store));

  test('emits a header and one row per n-gram', () => {
    const lines = toCsv(stats).trim().split('\n');
    expect(lines[0]).toStartWith('n,ngram,samples,median_ms');
    expect(lines).toHaveLength(stats.length + 1);
  });

  test('renders internal transitions in a single field', () => {
    const row = toCsv(stats.filter((s) => s.gram === 'para'));
    // Durations are stored rounded to 0.1 ms, so 500/3 comes back as 166.7.
    expect(row).toContain('p>a:166.70|a>r:166.70|r>a:166.70');
  });

  test('quotes n-grams containing a comma or a quote', () => {
    const commaStore = seed([['a,', 100, 1]]);
    const csv = toCsv(computeAllStats(commaStore, computeBaseline(commaStore)));
    expect(csv).toContain('"a,"');
  });

  test('escapes an embedded double quote by doubling it', () => {
    const quoteStore = seed([['a"', 100, 1]]);
    const csv = toCsv(computeAllStats(quoteStore, computeBaseline(quoteStore)));
    expect(csv).toContain('"a"""');
  });

  test('produces an ISO timestamp for the last observation', () => {
    expect(toCsv(stats)).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  test('handles an empty profile', () => {
    expect(toCsv([]).trim().split('\n')).toHaveLength(1);
  });
});
