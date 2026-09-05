import { beforeEach, describe, expect, test } from 'bun:test';
import { type RunEvent, RunTracker } from '../src/core/run';
import type { NgramSample } from '../src/core/types';

/** Types a string, advancing the clock by `gap` ms between keystrokes. */
function type(tracker: RunTracker, text: string, start = 1000, gap = 100): NgramSample[] {
  const out: NgramSample[] = [];
  let t = start;
  for (const char of [...text]) {
    out.push(...tracker.feed({ kind: 'char', char, t }).samples);
    t += gap;
  }
  return out;
}

function gramsOf(samples: NgramSample[]): string[] {
  return samples.map((s) => s.gram).sort();
}

describe('RunTracker', () => {
  let tracker: RunTracker;
  beforeEach(() => {
    tracker = new RunTracker();
  });

  test('emits nothing until the run is closed', () => {
    expect(type(tracker, 'para')).toEqual([]);
    expect(tracker.pending).toBe(4);
    expect(gramsOf(tracker.flush().samples)).toEqual(['ar', 'ara', 'pa', 'par', 'para', 'ra']);
  });

  test('a space closes the run so n-grams never cross a word boundary', () => {
    const emitted = type(tracker, 'la casa');
    expect(gramsOf(emitted)).toEqual(['la']);
    expect(gramsOf(tracker.flush().samples)).toEqual(['as', 'asa', 'ca', 'cas', 'casa', 'sa']);
  });

  test('spaces become ordinary characters when includeSpaces is on', () => {
    const spaced = new RunTracker({ includeSpaces: true });
    type(spaced, 'a b');
    expect(gramsOf(spaced.flush().samples)).toEqual([' b', 'a ', 'a b']);
  });

  test('a long pause splits the run without joining across it', () => {
    type(tracker, 'pa');
    // Three seconds of thinking, well past the 1000 ms default.
    const after = tracker.feed({ kind: 'char', char: 'r', t: 1100 + 3000 });
    expect(gramsOf(after.samples)).toEqual(['pa']);
    expect(after.runsClosed).toBe(1);

    tracker.feed({ kind: 'char', char: 'a', t: 4200 });
    expect(gramsOf(tracker.flush().samples)).toEqual(['ra']);
  });

  test('a backspace discards the corrected tail and keeps the clean prefix', () => {
    type(tracker, 'parx');
    const result = tracker.feed({ kind: 'delete', t: 1400 });
    expect(gramsOf(result.samples)).toEqual(['ar', 'pa', 'par']);
    expect(result.samples.some((s) => s.gram.includes('x'))).toBe(false);
  });

  test('a multi-character deletion rewinds by that many keystrokes', () => {
    type(tracker, 'parxy');
    const result = tracker.feed({ kind: 'delete', count: 2, t: 1500 });
    expect(gramsOf(result.samples)).toEqual(['ar', 'pa', 'par']);
  });

  test('deleting everything typed yields no n-grams', () => {
    type(tracker, 'pa');
    expect(tracker.feed({ kind: 'delete', count: 2, t: 1200 }).samples).toEqual([]);
  });

  test('an explicit break event closes the run', () => {
    type(tracker, 'pa');
    const event: RunEvent = { kind: 'break', reason: 'blur', t: 1200 };
    expect(gramsOf(tracker.feed(event).samples)).toEqual(['pa']);
    expect(tracker.pending).toBe(0);
  });

  test('an error break drops the run in progress', () => {
    type(tracker, 'p');
    expect(tracker.feed({ kind: 'break', reason: 'error', t: 1100 }).samples).toEqual([]);
  });

  test('records accented characters and eñes as ordinary letters', () => {
    type(tracker, 'mañana');
    expect(gramsOf(tracker.flush().samples)).toContain('aña');
  });

  test('normalizes decomposed input so accents share one bucket', () => {
    const composed = new RunTracker();
    type(composed, 'p\u00e1');
    const decomposed = new RunTracker();
    type(decomposed, 'pa\u0301');
    expect(gramsOf(decomposed.flush().samples)).toEqual(gramsOf(composed.flush().samples));
  });

  test('splits an over-long run without double-counting the overlap', () => {
    const capped = new RunTracker({ maxRunLength: 6 });
    const emitted = type(capped, 'abcdefgh');
    const all = [...emitted, ...capped.flush().samples];
    const counts = new Map<string, number>();
    for (const sample of all) counts.set(sample.gram, (counts.get(sample.gram) ?? 0) + 1);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
    // The seam is still bridged: a window spanning the split is present.
    expect(counts.get('defg')).toBe(1);
  });

  test('reconfiguring closes the current run before applying options', () => {
    type(tracker, 'pa');
    expect(gramsOf(tracker.configure({ includeSpaces: true }).samples)).toEqual(['pa']);
    expect(tracker.pending).toBe(0);
  });

  test('rejects a keystroke arriving before the previous one', () => {
    tracker.feed({ kind: 'char', char: 'a', t: 2000 });
    const result = tracker.feed({ kind: 'char', char: 'b', t: 1000 });
    expect(result.samples).toEqual([]);
    expect(tracker.flush().samples).toEqual([]);
  });
});
