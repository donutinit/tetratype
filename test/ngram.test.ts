import { describe, expect, test } from 'bun:test';
import { extractNgrams, gramKey } from '../src/core/ngram';
import type { Keystroke } from '../src/core/types';

/** Builds keystrokes from a word and the gaps between them. */
function run(word: string, gaps: number[]): Keystroke[] {
  const chars = [...word];
  let t = 1000;
  return chars.map((char, i) => {
    if (i > 0) t += gaps[i - 1] ?? 100;
    return { char, t };
  });
}

const OPTS = { maxTransitionMs: 1000 };

describe('extractNgrams', () => {
  test('extracts every window of length 2, 3 and 4', () => {
    const samples = extractNgrams(run('para', [90, 110, 80]), OPTS);
    const grams = samples.map((s) => s.gram).sort();
    expect(grams).toEqual(['ar', 'ara', 'pa', 'par', 'para', 'ra'].sort());
  });

  test('total duration spans first to last keystroke', () => {
    const samples = extractNgrams(run('para', [90, 110, 80]), OPTS);
    const para = samples.find((s) => s.gram === 'para');
    expect(para?.total).toBe(280);
    expect(para?.n).toBe(4);
  });

  test('records the internal transitions of a trigram', () => {
    const samples = extractNgrams(run('para', [90, 110, 80]), OPTS);
    expect(samples.find((s) => s.gram === 'par')?.transitions).toEqual([90, 110]);
    expect(samples.find((s) => s.gram === 'ara')?.transitions).toEqual([110, 80]);
  });

  test('a bigram has exactly one transition equal to its total', () => {
    const [bigram] = extractNgrams(run('pa', [90]), OPTS);
    expect(bigram?.transitions).toEqual([90]);
    expect(bigram?.total).toBe(90);
  });

  test('rejects windows containing a hesitation', () => {
    const samples = extractNgrams(run('para', [90, 4000, 80]), OPTS);
    expect(samples.map((s) => s.gram).sort()).toEqual(['pa', 'ra']);
  });

  test('rejects windows with a negative interval', () => {
    const keystrokes: Keystroke[] = [
      { char: 'a', t: 500 },
      { char: 'b', t: 400 },
    ];
    expect(extractNgrams(keystrokes, OPTS)).toEqual([]);
  });

  test('returns nothing for a run shorter than a bigram', () => {
    expect(extractNgrams(run('p', []), OPTS)).toEqual([]);
    expect(extractNgrams([], OPTS)).toEqual([]);
  });

  test('handles accented and non-ASCII characters', () => {
    const samples = extractNgrams(run('añó', [100, 120]), OPTS);
    expect(samples.map((s) => s.gram).sort()).toEqual(['añ', 'añó', 'ñó']);
  });

  test('honours an explicit size list', () => {
    const samples = extractNgrams(run('para', [90, 110, 80]), { ...OPTS, sizes: [2] });
    expect(samples.every((s) => s.n === 2)).toBe(true);
    expect(samples).toHaveLength(3);
  });
});

describe('gramKey', () => {
  test('namespaces by length so `pa` and `pa` of different n never collide', () => {
    expect(gramKey(2, 'pa')).toBe('2:pa');
    expect(gramKey(3, 'par')).toBe('3:par');
  });
});
