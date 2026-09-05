import { extractNgrams } from './ngram';
import { isWhitespace, normalize } from './text';
import type { BreakReason, Keystroke, NgramSample } from './types';

/** Input events the run tracker understands. */
export type RunEvent =
  | { kind: 'char'; char: string; t: number }
  | { kind: 'delete'; count?: number; t: number }
  | { kind: 'break'; reason: BreakReason; t: number };

export interface RunOptions {
  /** A gap longer than this ends the run: you stopped typing and thought. */
  breakOnPauseMs: number;
  /** Treat whitespace as an ordinary character instead of a run delimiter. */
  includeSpaces: boolean;
  /** Hard cap on run length, so a pathological page cannot grow it forever. */
  maxRunLength: number;
}

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  breakOnPauseMs: 1000,
  includeSpaces: false,
  maxRunLength: 512,
};

/** Longest n-gram we extract; kept as overlap when a long run is trimmed. */
const MAX_N = 4;

export interface RunResult {
  samples: NgramSample[];
  /** Number of runs that were closed while processing the event. */
  runsClosed: number;
}

const EMPTY: RunResult = { samples: [], runsClosed: 0 };

/**
 * Accumulates keystrokes into clean runs and emits n-grams when a run closes.
 *
 * A run is a stretch of typing with nothing suspicious in it. Anything that
 * would poison the timings — a space, a correction, a detected error, losing
 * focus, or simply pausing to think — closes the run so no n-gram ever spans
 * the interruption.
 *
 * Corrections are handled by rewinding: a backspace drops the keystrokes it
 * erased and then closes the run, which keeps the clean prefix (`p`, `a`, `r`
 * of a mistyped `para`) while discarding the part you had to fix.
 */
export class RunTracker {
  private buffer: Keystroke[] = [];
  private options: RunOptions;

  constructor(options: Partial<RunOptions> = {}) {
    this.options = { ...DEFAULT_RUN_OPTIONS, ...options };
  }

  /** Replaces the active options. The current run is closed first. */
  configure(options: Partial<RunOptions>): RunResult {
    const result = this.flush('flush');
    this.options = { ...this.options, ...options };
    return result;
  }

  /** Number of keystrokes currently held in the open run. */
  get pending(): number {
    return this.buffer.length;
  }

  /** Feeds one event and returns whatever n-grams that completed. */
  feed(event: RunEvent): RunResult {
    switch (event.kind) {
      case 'char':
        return this.onChar(event.char, event.t);
      case 'delete':
        return this.onDelete(event.count ?? 1);
      case 'break':
        return this.flush(event.reason);
    }
  }

  /** Closes the open run and returns its n-grams. */
  flush(_reason: BreakReason = 'flush'): RunResult {
    if (this.buffer.length < 2) {
      this.buffer = [];
      return EMPTY;
    }
    const samples = extractNgrams(this.buffer, {
      maxTransitionMs: this.options.breakOnPauseMs,
    });
    this.buffer = [];
    return { samples, runsClosed: 1 };
  }

  private onChar(rawChar: string, t: number): RunResult {
    const char = normalize(rawChar);

    if (!this.options.includeSpaces && isWhitespace(char)) {
      return this.flush('space');
    }

    const last = this.buffer[this.buffer.length - 1];
    if (last) {
      const delta = t - last.t;
      if (delta < 0 || delta > this.options.breakOnPauseMs) {
        const closed = this.flush('pause');
        this.buffer.push({ char, t });
        return closed;
      }
    }

    this.buffer.push({ char, t });

    if (this.buffer.length >= this.options.maxRunLength) {
      return this.trim();
    }
    return EMPTY;
  }

  private onDelete(count: number): RunResult {
    if (count > 0) {
      this.buffer.length = Math.max(0, this.buffer.length - count);
    }
    return this.flush('backspace');
  }

  /**
   * Emits the current run and restarts it from the tail, so a run longer than
   * `maxRunLength` stays bounded without losing n-grams across the seam.
   */
  private trim(): RunResult {
    const overlap = this.buffer.slice(-(MAX_N - 1));
    const result = this.flush('overflow');
    this.buffer = overlap;
    return result;
  }
}
