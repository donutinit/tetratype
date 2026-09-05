import { beforeEach, describe, expect, test } from 'bun:test';
import { Capture } from '../src/content/capture';
import type { Metrics } from '../src/core/metrics';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings';
import type { NgramSample } from '../src/core/types';

/**
 * Drives Capture against a stand-in for Monkeytype's live markup, updating the
 * letter classes after each keystroke exactly as the site does — which is what
 * makes the lookahead and the one-keystroke fallback behave realistically.
 */
class Typist {
  readonly capture: Capture;
  readonly samples: NgramSample[] = [];
  private input: HTMLTextAreaElement;
  private letters: HTMLElement[] = [];
  private index = 0;
  private clock = 1000;

  constructor(target: string, settings: Partial<Settings> = {}) {
    document.body.innerHTML = `
      <div id="typingTest">
        <div id="wordsWrapper">
          <textarea id="wordsInput"></textarea>
          <div id="words"><div class="word active"></div></div>
        </div>
      </div>
    `;
    this.input = document.getElementById('wordsInput') as HTMLTextAreaElement;
    this.setWord(target);
    this.capture = new Capture(
      { ...DEFAULT_SETTINGS, ...settings },
      {
        onSamples: (batch) => this.samples.push(...batch),
        onKeystroke: () => {},
      },
    );
  }

  /** Replaces the active word, as advancing past a space would. */
  setWord(target: string): this {
    const word = document.querySelector('#words .word.active') as HTMLElement;
    word.innerHTML = [...target].map((c) => `<letter>${c}</letter>`).join('');
    this.letters = [...word.querySelectorAll('letter')] as HTMLElement[];
    this.index = 0;
    return this;
  }

  /** Types one character and then marks the DOM the way Monkeytype would. */
  key(char: string, gap = 100): this {
    this.clock += gap;
    const t = this.clock;
    this.capture.handleKeyDown({
      target: this.input,
      timeStamp: t,
      isComposing: false,
      repeat: false,
    });
    const expected = this.letters[this.index]?.textContent ?? null;
    this.capture.handleBeforeInput({
      target: this.input,
      timeStamp: t + 0.4,
      isComposing: false,
      inputType: 'insertText',
      data: char,
    });
    const letter = this.letters[this.index];
    if (letter) {
      letter.className = expected === char ? 'correct' : 'incorrect';
      this.index += 1;
    }
    return this;
  }

  backspace(gap = 300): this {
    this.clock += gap;
    this.capture.handleBeforeInput({
      target: this.input,
      timeStamp: this.clock,
      isComposing: false,
      inputType: 'deleteContentBackward',
      data: null,
    });
    this.index = Math.max(0, this.index - 1);
    const letter = this.letters[this.index];
    if (letter) letter.className = '';
    return this;
  }

  end(): Metrics {
    this.capture.breakRun();
    return this.capture.drainMetrics();
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('accuracy capture', () => {
  test('counts a clean word as all correct', () => {
    const metrics = new Typist('casa').key('c').key('a').key('s').key('a').end();
    expect(metrics.totals).toMatchObject({ attempts: 4, errors: 0 });
    expect(metrics.chars.c).toEqual({ attempts: 1, errors: 0 });
    expect(Object.keys(metrics.confusions)).toEqual([]);
  });

  test('records what was owed against what was typed', () => {
    const metrics = new Typist('casa').key('c').key('a').key('z').end();
    expect(metrics.totals.errors).toBe(1);
    expect(metrics.chars.s).toEqual({ attempts: 1, errors: 1 });
    expect(metrics.chars.z).toBeUndefined();
  });

  test('keys transitions by the expected characters', () => {
    const metrics = new Typist('casa').key('c').key('a').key('s').end();
    expect(metrics.transitions['c>a']).toEqual({ attempts: 1, errors: 0 });
    expect(metrics.transitions['a>s']).toEqual({ attempts: 1, errors: 0 });
  });

  test('blames the transition into the character that went wrong', () => {
    const metrics = new Typist('casa').key('c').key('a').key('z').end();
    expect(metrics.transitions['a>s']).toEqual({ attempts: 1, errors: 1 });
  });

  test('times the recovery from a mistake that gets fixed', () => {
    const metrics = new Typist('casa')
      .key('c')
      .key('a')
      .key('z')
      .backspace(400)
      .key('s', 250)
      .end();

    const confusion = metrics.confusions['s>z'];
    expect(confusion).toMatchObject({ expected: 's', typed: 'z', count: 1, recoveryCount: 1 });
    // 400 ms noticing plus 250 ms retyping.
    expect(confusion?.recoveryMs).toBe(650);
    expect(metrics.totals.corrected).toBe(1);
  });

  test('counts a mistake typed straight past as uncorrected', () => {
    const typist = new Typist('casa').key('c').key('a').key('z').key('a');
    const metrics = typist.end();
    expect(metrics.confusions['s>z']).toMatchObject({ uncorrected: 1, recoveryCount: 0 });
    expect(metrics.totals.uncorrected).toBe(1);
  });

  test('settles an unfixed mistake when the test moves to the next word', () => {
    const typist = new Typist('casa').key('c').key('z');
    typist.setWord('para');
    typist.key('p');
    const metrics = typist.end();
    expect(metrics.confusions['a>z']).toMatchObject({ count: 1, uncorrected: 1 });
  });

  test('meeting the same letter later in the word is not a correction', () => {
    // `z` for the first `s`, then typing on. The later `s` is a different key
    // press at a different position and must not be timed as a fix.
    const metrics = new Typist('sas').key('z').key('a').key('s').end();
    expect(metrics.confusions['s>z']).toMatchObject({ uncorrected: 1, recoveryCount: 0 });
    expect(metrics.totals.corrected).toBe(0);
  });

  test('keeps the two directions of a swap apart', () => {
    const first = new Typist('as').key('s').backspace().key('a').end();
    const second = new Typist('sa').key('a').backspace().key('s').end();
    expect(Object.keys(first.confusions)).toEqual(['a>s']);
    expect(Object.keys(second.confusions)).toEqual(['s>a']);
  });

  test('files keystrokes into speed bands', () => {
    const metrics = new Typist('casa').key('c', 100).key('a', 60).key('s', 60).end();
    // The first keystroke has no interval; the other two land in the 50-75 band.
    expect(metrics.speed['2']?.attempts).toBe(2);
  });

  test('does not measure an interval across a correction', () => {
    const metrics = new Typist('casa').key('c').key('z').backspace(500).key('a', 200).end();
    const bands = Object.values(metrics.speed).reduce((sum, b) => sum + b.attempts, 0);
    // `c` starts the run and `a` follows a backspace, so only `z` is timed.
    expect(bands).toBe(1);
  });

  test('opens a session on the first keystroke', () => {
    const metrics = new Typist('casa').key('c').key('a').end();
    expect(metrics.sessions).toBe(1);
  });
});

describe('accuracy and the timing data', () => {
  test('a mistake breaks the run but keeps the clean prefix', () => {
    const typist = new Typist('casa').key('c').key('a').key('z').key('a');
    typist.end();
    const grams = typist.samples.map((s) => s.gram).sort();
    expect(grams).toEqual(['ca']);
    expect(grams.some((g) => g.includes('z'))).toBe(false);
  });

  test('a clean word still yields every n-gram', () => {
    const typist = new Typist('casa').key('c').key('a').key('s').key('a');
    typist.end();
    expect(typist.samples.map((s) => s.gram).sort()).toEqual([
      'as',
      'asa',
      'ca',
      'cas',
      'casa',
      'sa',
    ]);
  });
});

describe('trackAccuracy off', () => {
  test('records no accuracy data at all', () => {
    const metrics = new Typist('casa', { trackAccuracy: false }).key('c').key('z').end();
    expect(metrics.totals.attempts).toBe(0);
    expect(Object.keys(metrics.confusions)).toEqual([]);
    expect(Object.keys(metrics.chars)).toEqual([]);
  });

  test('still detects the mistake through Monkeytype markup', () => {
    const typist = new Typist('casa', { trackAccuracy: false }).key('c').key('a').key('z').key('a');
    typist.end();
    expect(typist.samples.some((s) => s.gram.includes('z'))).toBe(false);
  });
});

describe('unreadable markup', () => {
  test('falls back without recording confusions when letters are missing', () => {
    const typist = new Typist('casa');
    (document.querySelector('#words .word.active') as HTMLElement).innerHTML = '';
    const metrics = typist.key('c').key('a').end();
    expect(Object.keys(metrics.confusions)).toEqual([]);
    // The keystrokes are still counted, keyed by what was actually typed.
    expect(metrics.chars.c).toEqual({ attempts: 1, errors: 0 });
  });
});
