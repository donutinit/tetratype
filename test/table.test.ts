import { describe, expect, test } from 'bun:test';
import { type NgramStats, computeAllStats, computeBaseline } from '../src/core/stats';
import { applySample, createStore } from '../src/core/store';
import type { NgramSample } from '../src/core/types';
import { COLUMNS, compare, escapeHtml, renderDetail } from '../src/dashboard/table';

const OPTS = { recentWindow: 40, maxGrams: 1000 };

function sample(gram: string, total: number, transitions?: number[]): NgramSample {
  const n = gram.length as 2 | 3 | 4;
  return { n, gram, total, transitions: transitions ?? new Array(n - 1).fill(total / (n - 1)) };
}

function statsFor(gram: string, total: number, times = 10, transitions?: number[]): NgramStats {
  const store = createStore(0);
  for (const filler of ['ab', 'bc', 'cd']) {
    for (let i = 0; i < 20; i++) applySample(store, sample(filler, 100), OPTS, 1);
  }
  for (let i = 0; i < times; i++) applySample(store, sample(gram, total, transitions), OPTS, 1);
  const found = computeAllStats(store, computeBaseline(store)).find((s) => s.gram === gram);
  if (!found) throw new Error(`no stats for ${gram}`);
  return found;
}

describe('escapeHtml', () => {
  test('neutralises every character that could break out of markup', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;');
  });

  test('leaves ordinary and accented text alone', () => {
    expect(escapeHtml('año')).toBe('año');
  });
});

describe('column rendering', () => {
  const gramColumn = COLUMNS[0]!;

  test('renders an n-gram with an expand caret', () => {
    expect(gramColumn.render(statsFor('pa', 100))).toContain('pa');
    expect(gramColumn.render(statsFor('pa', 100))).toContain('caret');
  });

  test('escapes an n-gram made of markup characters', () => {
    const html = gramColumn.render(statsFor('<b', 100));
    expect(html).toContain('&lt;b');
    expect(html).not.toContain('<b>');
  });

  test('makes a space visible instead of rendering nothing', () => {
    expect(gramColumn.render(statsFor('a ', 100))).toContain('␣');
  });

  test('every column produces a value for every n-gram length', () => {
    for (const gram of ['pa', 'par', 'para']) {
      for (const column of COLUMNS) {
        expect(column.render(statsFor(gram, 300))).not.toBe('');
      }
    }
  });
});

describe('compare', () => {
  const fast = statsFor('ab', 100);
  const slow = statsFor('zz', 400);

  test('sorts numerically in both directions', () => {
    expect(compare(fast, slow, 'median', false)).toBeLessThan(0);
    expect(compare(fast, slow, 'median', true)).toBeGreaterThan(0);
  });

  test('sorts n-grams alphabetically', () => {
    expect(compare(fast, slow, 'gram', false)).toBeLessThan(0);
    expect(compare(slow, fast, 'gram', false)).toBeGreaterThan(0);
  });
});

describe('renderDetail', () => {
  test('lists every internal transition of a tetragram', () => {
    const html = renderDetail(statsFor('para', 480, 10, [90, 300, 90]), 10);
    expect(html).toContain('p → a');
    expect(html).toContain('a → r');
    expect(html).toContain('r → a');
    expect(html).toContain('Total');
  });

  test('sizes the bar segments by their share of the total', () => {
    const html = renderDetail(statsFor('para', 480, 10, [90, 300, 90]), 10);
    const widths = [...html.matchAll(/width:([\d.]+)%/g)].map((m) => Number(m[1]));
    expect(widths).toHaveLength(3);
    expect(widths[1]).toBeGreaterThan(widths[0]! + widths[2]!);
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 1);
  });

  test('splits accented n-grams on grapheme boundaries', () => {
    expect(renderDetail(statsFor('año', 220), 10)).toContain('a → ñ');
  });

  test('escapes transition characters', () => {
    expect(renderDetail(statsFor('<b>', 220), 10)).not.toContain('<b>');
  });

  test('renders nothing for a bigram opened by mistake', () => {
    const bigram = statsFor('pa', 100);
    expect(renderDetail({ ...bigram, transitions: [] }, 10)).toBe('');
  });
});
