/**
 * Turns DOM input events into clean keystroke runs.
 *
 * The timestamp of a character is the `keydown` that produced it, not the
 * `beforeinput` that reports it, because keydown is when your finger actually
 * moved. For a dead key the producing keydown is the second press, so the time
 * to type `á` correctly includes the accent.
 */

import { RunTracker } from '../core/run';
import { isSingleGrapheme, normalize } from '../core/text';
import type { NgramSample, Settings } from './deps';
import { activeWord, countWrongLetters, isTypingInput } from './monkeytype';

/** How stale a pending keydown may be before we stop trusting the pairing. */
const KEYDOWN_FRESHNESS_MS = 150;

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

export interface CaptureSink {
  onSamples: (samples: NgramSample[], runs: number) => void;
  onKeystroke: () => void;
}

export class Capture {
  private tracker: RunTracker;
  private settings: Settings;
  private sink: CaptureSink;

  /** Timestamp of the most recent keydown, used to date the character it made. */
  private pendingKeyAt = -1;
  private composing = false;
  /** Wrong letters seen in the active word at the previous keystroke. */
  private wrongLetters = 0;
  private wordRef: Element | null = null;

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
    this.pendingKeyAt = -1;
    this.composing = false;
  }

  handleKeyDown(event: KeyboardEvent): void {
    if (!this.settings.capture || !isTypingInput(event.target)) return;
    if (event.isComposing) return;
    if (event.repeat) {
      // Held keys are not typing; the intervals they produce are meaningless.
      this.breakRun();
      return;
    }
    this.pendingKeyAt = event.timeStamp;
  }

  handleBeforeInput(event: InputEvent): void {
    if (!this.settings.capture || !isTypingInput(event.target)) return;
    if (this.composing || event.isComposing) return;

    const type = event.inputType;

    if (type === 'deleteContentBackward' || type === 'deleteContentForward') {
      this.syncErrors(event.timeStamp);
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
  }

  handleCompositionEnd(event: CompositionEvent): void {
    this.composing = false;
    if (!this.settings.capture || !isTypingInput(event.target)) return;
    this.commitText(event.data ?? '', event.timeStamp);
  }

  /** Records one produced character, or breaks the run if it is not one. */
  private commitText(raw: string, eventTime: number): void {
    const text = normalize(raw);
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

    this.syncErrors(t);
    this.sink.onKeystroke();
    this.emit(this.tracker.feed({ kind: 'char', char: text, t }));
  }

  /**
   * Drops the previous character if Monkeytype has just flagged it.
   *
   * The site updates its markup after handling the keystroke, so a mistake is
   * visible by the time the next one arrives. Rewinding one character removes
   * the wrong keypress and the hesitation that usually follows it.
   */
  private syncErrors(t: number): void {
    if (!this.settings.detectErrors) return;
    const word = activeWord();
    if (word !== this.wordRef) {
      this.wordRef = word;
      this.wrongLetters = Math.max(0, countWrongLetters(word));
      return;
    }
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
