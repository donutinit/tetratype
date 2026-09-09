/**
 * Turns DOM input events into clean keystroke runs.
 *
 * The timestamp of a character is the `keydown` that produced it, not the
 * `beforeinput` that reports it, because keydown is when your finger actually
 * moved. A dead key takes two presses, and both are kept: the accent is fed to
 * the run tracker as a keystroke of its own, timed at the press that made it.
 */

import { getLayout } from '../core/layout';
import { type Metrics, createMetrics, recordConfusion, recordKeystroke } from '../core/metrics';
import { RunTracker } from '../core/run';
import { isSingleGrapheme, normalize } from '../core/text';
import type { NgramSample, Settings } from './deps';
import { activeWord, countWrongLetters, expectedChar, isTypingInput } from './monkeytype';

/** How stale a pending keydown may be before we stop trusting the pairing. */
const KEYDOWN_FRESHNESS_MS = 150;

/** `KeyboardEvent.key` for an accent key that modifies the next character. */
const DEAD_KEY = 'Dead';

/** Idle time that ends a session, so warm-up and fatigue can be separated. */
const SESSION_IDLE_MS = 5 * 60 * 1000;

/** Deletion of an unknown length: drop everything buffered. */
const DELETE_ALL = Number.POSITIVE_INFINITY;

/** Input types that mean text arrived from somewhere other than the keyboard. */
const NON_TYPED_INPUT = new Set([
  'insertFromPaste',
  'insertFromDrop',
  'insertFromYank',
  'insertReplacementText',
  'insertFromPasteAsQuotation',
  'insertTranspose',
  'historyUndo',
  'historyRedo',
]);

/** Deletions where we cannot tell how many characters went away. */
const WIDE_DELETE = new Set([
  'deleteWordBackward',
  'deleteWordForward',
  'deleteSoftLineBackward',
  'deleteHardLineBackward',
  'deleteByCut',
  'deleteByDrag',
  'deleteEntireSoftLine',
]);

/**
 * Structural views of the DOM events this module consumes.
 *
 * Real `KeyboardEvent`, `InputEvent` and `CompositionEvent` objects satisfy
 * these, so the content script passes them straight through — and tests can
 * describe a keypress as a plain object instead of faking a DOM event.
 */
export interface KeyDownLike {
  target: EventTarget | null;
  timeStamp: number;
  isComposing: boolean;
  repeat: boolean;
  /** `KeyboardEvent.key`; optional so a test can describe a plain keypress. */
  key?: string;
}

export interface BeforeInputLike {
  target: EventTarget | null;
  timeStamp: number;
  isComposing: boolean;
  inputType: string;
  data: string | null;
}

export interface CompositionLike {
  target: EventTarget | null;
  timeStamp: number;
  data: string | null;
}

export interface CaptureSink {
  onSamples: (samples: NgramSample[], runs: number) => void;
  onKeystroke: () => void;
}

/** A mistake waiting to see whether it gets fixed. */
interface PendingError {
  expected: string;
  typed: string;
  /** Event timestamp of the wrong keystroke. */
  at: number;
  /** True once a deletion has taken the cursor back to the mistake. */
  rewound: boolean;
}

export class Capture {
  private tracker: RunTracker;
  private settings: Settings;
  private sink: CaptureSink;

  /** Timestamp of the most recent keydown, used to date the character it made. */
  private pendingKeyAt = -1;
  /** Timestamp of a dead-key press waiting for the letter it will accent. */
  private deadKeyAt = -1;
  private composing = false;
  /** Wrong letters seen in the active word at the previous keystroke. */
  private wrongLetters = 0;
  private wordRef: Element | null = null;

  /** Accuracy counters since the last drain. */
  private metrics: Metrics = createMetrics();
  /** The character owed by the previous keystroke, for transition keys. */
  private previousExpected: string | null = null;
  /** Event timestamp of the previous keystroke, for the interval. */
  private previousAt = -1;
  /** Wall-clock time of the last keystroke, for session boundaries. */
  private lastActivityAt = 0;
  /** Keystrokes so far in the current session. */
  private sessionIndex = 0;
  private pendingError: PendingError | null = null;

  constructor(settings: Settings, sink: CaptureSink) {
    this.settings = settings;
    this.sink = sink;
    this.tracker = new RunTracker({
      breakOnPauseMs: settings.breakOnPauseMs,
      includeSpaces: settings.includeSpaces,
    });
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    this.emit(
      this.tracker.configure({
        breakOnPauseMs: settings.breakOnPauseMs,
        includeSpaces: settings.includeSpaces,
      }),
    );
  }

  /** Closes the current run, e.g. on blur or when capture is paused. */
  breakRun(): void {
    this.emit(this.tracker.flush('blur'));
    this.resolvePending(null);
    this.pendingKeyAt = -1;
    this.deadKeyAt = -1;
    this.previousAt = -1;
    this.previousExpected = null;
    this.composing = false;
  }

  /**
   * Hands over the accuracy counters and starts fresh.
   *
   * The content script drains these on the same schedule as the timings, so a
   * batch carries both halves of the picture.
   */
  drainMetrics(): Metrics {
    const drained = this.metrics;
    this.metrics = createMetrics();
    return drained;
  }

  handleKeyDown(event: KeyDownLike): void {
    if (!this.settings.capture || !isTypingInput(event.target)) return;
    if (event.repeat) {
      // Held keys are not typing; the intervals they produce are meaningless.
      this.breakRun();
      return;
    }
    if (this.isDeadKey(event.key)) {
      // An accent key emits no text of its own, so note when it was pressed:
      // the letter it composes will need it back.
      this.deadKeyAt = event.timeStamp;
    }
    // Recorded even mid-composition: for a dead key the character comes from
    // the second press, and that one arrives with the composition still open.
    this.pendingKeyAt = event.timeStamp;
  }

  handleBeforeInput(event: BeforeInputLike): void {
    if (!this.settings.capture || !isTypingInput(event.target)) return;
    if (this.composing || event.isComposing) return;

    const type = event.inputType;

    if (type === 'deleteContentBackward' || type === 'deleteContentForward') {
      // A correction is not a keystroke against a target, but it does break the
      // timing chain, so the next character is not measured against this one.
      this.previousAt = -1;
      if (this.pendingError) this.pendingError.rewound = true;
      this.watchWord(activeWord());
      this.emit(this.tracker.feed({ kind: 'delete', count: 1, t: event.timeStamp }));
      return;
    }
    if (WIDE_DELETE.has(type)) {
      this.emit(this.tracker.feed({ kind: 'delete', count: DELETE_ALL, t: event.timeStamp }));
      return;
    }
    if (NON_TYPED_INPUT.has(type)) {
      this.emit(this.tracker.feed({ kind: 'break', reason: 'nontext', t: event.timeStamp }));
      return;
    }
    if (type !== 'insertText' && type !== 'insertLineBreak' && type !== 'insertParagraph') {
      return;
    }

    const data = type === 'insertText' ? (event.data ?? '') : '\n';
    this.commitText(data, event.timeStamp);
  }

  handleCompositionStart(): void {
    this.composing = true;
    // Layouts that route their dead keys through composition never report a
    // `Dead` key, so the press that opened the composition is the accent.
    if (this.deadKeyAt < 0) this.deadKeyAt = this.pendingKeyAt;
  }

  handleCompositionEnd(event: CompositionLike): void {
    this.composing = false;
    if (!this.settings.capture || !isTypingInput(event.target)) return;
    this.commitText(event.data ?? '', event.timeStamp);
  }

  /** Records one produced character, or breaks the run if it is not one. */
  private commitText(raw: string, eventTime: number): void {
    const text = normalize(raw);
    // The accent belongs to this character or to nothing: whatever happens
    // below, it must not be carried over to a later one.
    const deadAt = this.deadKeyAt;
    this.deadKeyAt = -1;

    if (text === '' || !isSingleGrapheme(text)) {
      // Zero or several characters at once: not a single keystroke.
      this.emit(this.tracker.feed({ kind: 'break', reason: 'nontext', t: eventTime }));
      return;
    }

    const fresh = this.pendingKeyAt >= 0 && eventTime - this.pendingKeyAt <= KEYDOWN_FRESHNESS_MS;
    if (!fresh) {
      // Text with no keypress behind it: autofill, or a synthetic event.
      this.emit(this.tracker.feed({ kind: 'break', reason: 'nontext', t: eventTime }));
      return;
    }
    const t = this.pendingKeyAt;
    this.pendingKeyAt = -1;

    const word = activeWord();
    this.watchWord(word);

    // Read the target before Monkeytype consumes the keystroke, so the answer
    // describes this keypress rather than the one before it.
    const expected = this.settings.trackAccuracy ? expectedChar(word) : null;
    const wrong = expected !== null && expected !== text;

    this.sink.onKeystroke();
    if (this.settings.trackAccuracy) this.record(expected, text, wrong, t);

    if (wrong && this.settings.detectErrors) {
      // Everything before this keystroke was right, so commit it and start over
      // rather than letting the mistake and the hesitation after it into a run.
      this.emit(this.tracker.feed({ kind: 'break', reason: 'error', t }));
      return;
    }

    if (expected === null && this.settings.detectErrors) {
      // No target to compare against: fall back to watching Monkeytype's own
      // markup, which only tells us about the previous keystroke.
      this.syncErrors(t);
    }

    const dead = this.deadKeyPress(text, t, deadAt);
    if (dead) {
      // Two presses made this character, so the run gets two keystrokes: the
      // accent, then the letter. `´o` is a real transition and now it is timed.
      this.emit(this.tracker.feed({ kind: 'char', char: dead.accent, t: dead.at }));
      this.emit(this.tracker.feed({ kind: 'char', char: dead.base, t }));
      return;
    }

    this.emit(this.tracker.feed({ kind: 'char', char: text, t }));
  }

  /**
   * True for a keypress that starts an accent rather than producing a letter.
   *
   * Browsers report a dead key as `Dead` on most platforms, but some name the
   * accent it carries instead, so the layout's own accent keys count too. A
   * false positive is harmless: the next character decides whether it is used.
   */
  private isDeadKey(key: string | undefined): boolean {
    if (key === undefined) return false;
    return key === DEAD_KEY || getLayout(this.settings.layout).deadKeys.has(key);
  }

  /**
   * Splits a character into the accent press and the letter press behind it.
   *
   * The layout decides: `ó` is a dead key and a vowel on a Spanish board, while
   * a layout with a key of its own for it costs one press and stays one. Null
   * whenever no accent key is waiting, which is every ordinary keystroke.
   */
  private deadKeyPress(
    char: string,
    t: number,
    deadAt: number,
  ): { accent: string; base: string; at: number } | null {
    if (!this.settings.splitDeadKeys || deadAt < 0 || deadAt >= t) return null;
    const parts = getLayout(this.settings.layout).composed.get(char);
    return parts ? { accent: parts[0], base: parts[1], at: deadAt } : null;
  }

  /** Folds one keystroke into the accuracy counters. */
  private record(expected: string | null, typed: string, wrong: boolean, t: number): void {
    this.touchSession();

    const gap = this.previousAt >= 0 ? t - this.previousAt : -1;
    const withinRun = gap >= 0 && gap <= this.settings.breakOnPauseMs;

    recordKeystroke(this.metrics, {
      expected,
      typed,
      wrong,
      intervalMs: withinRun ? gap : null,
      previousExpected: this.previousExpected,
      sessionIndex: this.sessionIndex,
      at: Date.now(),
    });

    this.sessionIndex += 1;
    this.previousAt = t;
    this.previousExpected = expected ?? typed;

    if (wrong && expected !== null) {
      // A second mistake before the first was fixed: the first one stands.
      this.resolvePending(null);
      this.pendingError = { expected, typed, at: t, rewound: false };
      return;
    }

    // A correction only counts once the cursor has been taken back over the
    // mistake. Typing on past an error and happening to meet the same letter
    // later in the word is not a fix, and must not be timed as one.
    const pending = this.pendingError;
    if (pending?.rewound && expected === pending.expected && expected === typed) {
      this.resolvePending(t);
    }
  }

  /**
   * Closes an outstanding mistake.
   *
   * `at` is when the right character eventually arrived, or null when the
   * mistake was left standing — typing on past an error is a different habit
   * from fixing it, and worth counting separately.
   */
  private resolvePending(at: number | null): void {
    const pending = this.pendingError;
    if (!pending) return;
    this.pendingError = null;
    recordConfusion(this.metrics, pending.expected, pending.typed, {
      recoveryMs: at === null ? null : at - pending.at,
      uncorrected: at === null,
    });
  }

  /** Starts a new session after a long enough gap away from the keyboard. */
  private touchSession(): void {
    const now = Date.now();
    if (this.lastActivityAt === 0 || now - this.lastActivityAt > SESSION_IDLE_MS) {
      this.metrics.sessions += 1;
      this.sessionIndex = 0;
    }
    this.lastActivityAt = now;
  }

  /** Notices when the test moves on, which settles any unfixed mistake. */
  private watchWord(word: Element | null): void {
    if (word === this.wordRef) return;
    this.resolvePending(null);
    this.wordRef = word;
    this.wrongLetters = Math.max(0, countWrongLetters(word));
  }

  /**
   * Drops the previous character if Monkeytype has just flagged it.
   *
   * Only used when the expected character could not be read. The site updates
   * its markup after handling a keystroke, so a mistake is visible by the time
   * the next one arrives; rewinding one character removes the wrong keypress
   * and the hesitation that usually follows it.
   */
  private syncErrors(t: number): void {
    const word = this.wordRef;
    const wrong = countWrongLetters(word);
    if (wrong < 0) return;
    if (wrong > this.wrongLetters) {
      this.emit(this.tracker.feed({ kind: 'delete', count: 1, t }));
    }
    this.wrongLetters = wrong;
  }

  private emit(result: { samples: NgramSample[]; runsClosed: number }): void {
    if (result.samples.length > 0 || result.runsClosed > 0) {
      this.sink.onSamples(result.samples, result.runsClosed);
    }
  }
}
