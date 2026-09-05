import { type Keystroke, NGRAM_SIZES, type NgramSample, type NgramSize } from './types';

export interface ExtractOptions {
  /** Intervals above this are treated as a hesitation and reject the window. */
  maxTransitionMs: number;
  /** Which n-gram lengths to extract. Defaults to 2, 3 and 4. */
  sizes?: readonly NgramSize[];
}

/**
 * Turns one uninterrupted run of keystrokes into n-gram observations.
 *
 * A window is rejected when any of its inter-key intervals is negative (clock
 * anomalies) or longer than `maxTransitionMs`. The run tracker already breaks
 * on long pauses, so this is a second line of defence rather than the main one.
 */
export function extractNgrams(run: readonly Keystroke[], opts: ExtractOptions): NgramSample[] {
  const sizes = opts.sizes ?? NGRAM_SIZES;
  const samples: NgramSample[] = [];

  for (const n of sizes) {
    for (let i = 0; i + n <= run.length; i++) {
      const window = run.slice(i, i + n);
      const transitions: number[] = [];
      let ok = true;

      for (let k = 1; k < window.length; k++) {
        const prev = window[k - 1]!;
        const cur = window[k]!;
        const delta = cur.t - prev.t;
        if (delta < 0 || delta > opts.maxTransitionMs) {
          ok = false;
          break;
        }
        transitions.push(delta);
      }
      if (!ok) continue;

      const first = window[0]!;
      const last = window[window.length - 1]!;
      samples.push({
        n,
        gram: window.map((k) => k.char).join(''),
        total: last.t - first.t,
        transitions,
      });
    }
  }

  return samples;
}

/** Builds the storage key for an n-gram record. */
export function gramKey(n: NgramSize, gram: string): string {
  return `${n}:${gram}`;
}
