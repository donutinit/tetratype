import { beforeEach, describe, expect, test } from 'bun:test';
import { Capture } from '../src/content/capture';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings';
import type { NgramSample } from '../src/core/types';

let input: HTMLTextAreaElement;
let samples: NgramSample[];
let keystrokes: number;
let runs: number;

function mount(): void {
  document.body.innerHTML = `
    <div id="typingTest">
      <div id="wordsWrapper">
        <textarea id="wordsInput" autocomplete="off"></textarea>
        <div id="words">
          <div class="word active"></div>
        </div>
      </div>
    </div>
    <input id="password" type="password" />
  `;
  input = document.getElementById('wordsInput') as HTMLTextAreaElement;
}

function makeCapture(overrides: Partial<Settings> = {}): Capture {
  samples = [];
  keystrokes = 0;
  runs = 0;
  return new Capture(
    { ...DEFAULT_SETTINGS, ...overrides },
    {
      onSamples: (batch, closed) => {
        samples.push(...batch);
        runs += closed;
      },
      onKeystroke: () => {
        keystrokes++;
      },
    },
  );
}

/** Fires the keydown + beforeinput pair Firefox produces for one keypress. */
function press(
  capture: Capture,
  char: string,
  t: number,
  target: EventTarget = input,
  inputType = 'insertText',
): void {
  capture.handleKeyDown({
    target,
    timeStamp: t,
    isComposing: false,
    repeat: false,
  });
  capture.handleBeforeInput({
    target,
    timeStamp: t + 1,
    isComposing: false,
    inputType,
    data: char,
  });
}

function grams(): string[] {
  return samples.map((s) => s.gram).sort();
}

beforeEach(mount);

describe('Capture', () => {
  test('records a word and times it from the keydowns', () => {
    const capture = makeCapture();
    press(capture, 'p', 1000);
    press(capture, 'a', 1100);
    press(capture, 'r', 1200);
    press(capture, 'a', 1300);
    capture.breakRun();

    expect(grams()).toEqual(['ar', 'ara', 'pa', 'par', 'para', 'ra']);
    expect(keystrokes).toBe(4);
    expect(runs).toBe(1);
    // Timing comes from keydown, not from the beforeinput a millisecond later.
    expect(samples.find((s) => s.gram === 'para')?.total).toBe(300);
    expect(samples.find((s) => s.gram === 'par')?.transitions).toEqual([100, 100]);
  });

  test('ignores keystrokes outside the typing input', () => {
    const capture = makeCapture();
    const password = document.getElementById('password') as HTMLInputElement;
    press(capture, 's', 1000, password);
    press(capture, 'e', 1100, password);
    capture.breakRun();
    expect(samples).toEqual([]);
    expect(keystrokes).toBe(0);
  });

  test('does nothing at all while capture is paused', () => {
    const capture = makeCapture({ capture: false });
    press(capture, 'p', 1000);
    press(capture, 'a', 1100);
    capture.breakRun();
    expect(samples).toEqual([]);
    expect(keystrokes).toBe(0);
  });

  test('a space ends the run', () => {
    const capture = makeCapture();
    press(capture, 'l', 1000);
    press(capture, 'a', 1100);
    press(capture, ' ', 1200);
    press(capture, 'y', 1300);
    press(capture, 'a', 1400);
    capture.breakRun();
    expect(grams()).toEqual(['la', 'ya']);
  });

  test('a backspace discards the corrected character', () => {
    const capture = makeCapture();
    press(capture, 'p', 1000);
    press(capture, 'a', 1100);
    press(capture, 'x', 1200);
    capture.handleBeforeInput({
      target: input,
      timeStamp: 1300,
      isComposing: false,
      inputType: 'deleteContentBackward',
      data: null,
    });
    expect(grams()).toEqual(['pa']);
  });

  test('a word deletion throws away the whole run', () => {
    const capture = makeCapture();
    press(capture, 'p', 1000);
    press(capture, 'a', 1100);
    capture.handleBeforeInput({
      target: input,
      timeStamp: 1200,
      isComposing: false,
      inputType: 'deleteWordBackward',
      data: null,
    });
    expect(samples).toEqual([]);
  });

  test('pasted text never becomes a sample', () => {
    const capture = makeCapture();
    press(capture, 'p', 1000);
    press(capture, 'a', 1100);
    capture.handleBeforeInput({
      target: input,
      timeStamp: 1200,
      isComposing: false,
      inputType: 'insertFromPaste',
      data: 'paragraph',
    });
    press(capture, 'r', 1300);
    press(capture, 'a', 1400);
    capture.breakRun();
    expect(grams()).toEqual(['pa', 'ra']);
  });

  test('multi-character insertions break the run', () => {
    const capture = makeCapture();
    press(capture, 'p', 1000);
    press(capture, 'ar', 1100);
    press(capture, 'a', 1200);
    capture.breakRun();
    expect(samples).toEqual([]);
  });

  test('text with no keypress behind it is rejected', () => {
    const capture = makeCapture();
    press(capture, 'p', 1000);
    // Autofill: a beforeinput with no matching keydown.
    capture.handleBeforeInput({
      target: input,
      timeStamp: 5000,
      isComposing: false,
      inputType: 'insertText',
      data: 'a',
    });
    capture.breakRun();
    expect(samples).toEqual([]);
  });

  test('a held key breaks the run instead of timing repeats', () => {
    const capture = makeCapture();
    press(capture, 'a', 1000);
    press(capture, 'b', 1100);
    capture.handleKeyDown({
      target: input,
      timeStamp: 1150,
      isComposing: false,
      repeat: true,
    });
    press(capture, 'c', 1200);
    capture.breakRun();
    expect(grams()).toEqual(['ab']);
  });

  test('a long pause splits the run', () => {
    const capture = makeCapture({ breakOnPauseMs: 500 });
    press(capture, 'p', 1000);
    press(capture, 'a', 1100);
    press(capture, 'r', 3000);
    press(capture, 'a', 3100);
    capture.breakRun();
    expect(grams()).toEqual(['pa', 'ra']);
  });

  test('records an accented character produced by a dead key', () => {
    const capture = makeCapture();
    // The dead key itself emits no text, then the vowel arrives composed.
    capture.handleKeyDown({
      target: input,
      timeStamp: 1000,
      isComposing: false,
      repeat: false,
    });
    press(capture, 'm', 1100);
    press(capture, 'á', 1200);
    press(capture, 's', 1300);
    capture.breakRun();
    expect(grams()).toContain('más');
  });

  test('composes an accent delivered as a separate combining mark', () => {
    const capture = makeCapture();
    press(capture, 'm', 1000);
    // Some layouts emit the base letter and the accent as two input events.
    press(capture, 'a', 1100);
    press(capture, '\u0301', 1150);
    press(capture, 's', 1300);
    capture.breakRun();
    expect(grams()).toContain('m\u00e1s');
    expect(grams()).not.toContain('as');
  });

  test('composition delivers one character at compositionend', () => {
    const capture = makeCapture();
    press(capture, 'a', 1000);
    capture.handleCompositionStart();
    capture.handleBeforeInput({
      target: input,
      timeStamp: 1100,
      isComposing: true,
      inputType: 'insertCompositionText',
      data: '~',
    });
    capture.handleKeyDown({
      target: input,
      timeStamp: 1200,
      isComposing: false,
      repeat: false,
    });
    capture.handleCompositionEnd({
      target: input,
      timeStamp: 1210,
      data: 'ñ',
    });
    press(capture, 'o', 1300);
    capture.breakRun();
    expect(grams()).toEqual(['añ', 'año', 'ño']);
  });

  test('drops a keystroke Monkeytype flags as wrong', () => {
    const capture = makeCapture();
    const word = document.querySelector('#words .word') as HTMLElement;
    press(capture, 'p', 1000);
    press(capture, 'a', 1100);
    press(capture, 'z', 1200);
    // Monkeytype marks the mistake once it has handled the keystroke.
    word.insertAdjacentHTML('beforeend', '<letter class="incorrect">z</letter>');
    press(capture, 'a', 1900);
    capture.breakRun();
    expect(grams()).toEqual(['pa']);
  });

  test('error detection can be turned off', () => {
    const capture = makeCapture({ detectErrors: false });
    const word = document.querySelector('#words .word') as HTMLElement;
    press(capture, 'p', 1000);
    press(capture, 'a', 1100);
    press(capture, 'z', 1200);
    word.insertAdjacentHTML('beforeend', '<letter class="incorrect">z</letter>');
    press(capture, 'a', 1300);
    capture.breakRun();
    expect(grams()).toContain('paza');
  });

  test('changing settings closes the run in progress', () => {
    const capture = makeCapture();
    press(capture, 'p', 1000);
    press(capture, 'a', 1100);
    capture.updateSettings({ ...DEFAULT_SETTINGS, includeSpaces: true });
    expect(grams()).toEqual(['pa']);
  });
});
