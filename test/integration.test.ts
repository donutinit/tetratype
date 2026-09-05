import { beforeEach, describe, expect, test } from 'bun:test';
import { Capture } from '../src/content/capture';
import { buildExport, parseExport, toCsv } from '../src/core/serialize';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings';
import { type NgramStats, computeAllStats, computeBaseline, summarize } from '../src/core/stats';
import { type StoreOptions, applyBatch, createStore } from '../src/core/store';
import type { NgramSample, ProfileStore } from '../src/core/types';

const OPTS: StoreOptions = { recentWindow: 40, maxGrams: 12000 };

/**
 * Drives the real capture layer the way the content script does, and folds the
 * result into a real store, so the seams between the layers are exercised.
 */
class Session {
  readonly store: ProfileStore = createStore(0);
  private capture: Capture;
  private input: HTMLTextAreaElement;
  private clock = 1000;

  constructor(settings: Partial<Settings> = {}) {
    document.body.innerHTML = `
      <div id="typingTest">
        <div id="wordsWrapper">
          <textarea id="wordsInput" autocomplete="off"></textarea>
          <div id="words">
            <div class="word active"></div>
          </div>
        </div>
      </div>
    `;
    this.input = document.getElementById('wordsInput') as HTMLTextAreaElement;
    this.capture = new Capture(
      { ...DEFAULT_SETTINGS, ...settings },
      {
        onSamples: (samples: NgramSample[], runs: number) =>
          applyBatch(this.store, { samples, runs }, OPTS, 1),
        onKeystroke: () => {
          this.store.totals.keystrokes++;
        },
      },
    );
  }

  /** Types one character `gap` milliseconds after the previous one. */
  key(char: string, gap: number): this {
    this.clock += gap;
    const t = this.clock;
    this.capture.handleKeyDown({
      target: this.input,
      timeStamp: t,
      isComposing: false,
      repeat: false,
    });
    this.capture.handleBeforeInput({
      target: this.input,
      timeStamp: t + 0.4,
      isComposing: false,
      inputType: 'insertText',
      data: char,
    });
    return this;
  }

  /** Types a word at a steady pace, then a space to close the run. */
  word(text: string, gap: number, space = true): this {
    for (const char of [...text]) this.key(char, gap);
    if (space) this.key(' ', gap);
    return this;
  }

  backspace(gap: number): this {
    this.clock += gap;
    this.capture.handleBeforeInput({
      target: this.input,
      timeStamp: this.clock,
      isComposing: false,
      inputType: 'deleteContentBackward',
      data: null,
    });
    return this;
  }

  end(): this {
    this.capture.breakRun();
    return this;
  }

  stats(): NgramStats[] {
    const baseline = computeBaseline(this.store);
    return computeAllStats(this.store, baseline);
  }

  find(gram: string): NgramStats | undefined {
    return this.stats().find((s) => s.gram === gram);
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('a typing session end to end', () => {
  test('builds a profile from Spanish words', () => {
    const session = new Session();
    for (let i = 0; i < 12; i++) {
      session.word('para', 100).word('casa', 120).word('mañana', 110);
    }
    session.end();

    expect(session.store.totals.keystrokes).toBe(12 * (5 + 5 + 7));
    expect(session.find('para')?.count).toBe(12);
    expect(session.find('aña')?.count).toBe(12);
    // Spaces close runs, so no n-gram bridges two words.
    expect(session.find('ac')).toBeUndefined();
  });

  test('reports the slower word as slower', () => {
    const session = new Session();
    for (let i = 0; i < 10; i++) {
      session.word('casa', 90).word('jugo', 260);
    }
    session.end();

    const fast = session.find('cas')!;
    const slow = session.find('jug')!;
    expect(fast.msPerTransition).toBeLessThan(slow.msPerTransition);
    expect(slow.msLost).toBeGreaterThan(fast.msLost);
    expect(slow.impact).toBeGreaterThan(fast.impact);
  });

  test('surfaces the slow transition inside an otherwise fast tetragram', () => {
    const session = new Session();
    for (let i = 0; i < 10; i++) {
      // `p→a` fast, `a→r` slow, `r→a` fast.
      session.key('p', 90).key('a', 90).key('r', 300).key('a', 90).key(' ', 100);
    }
    session.end();

    const para = session.find('para')!;
    expect(para.transitions.map((t) => `${t.from}>${t.to}`)).toEqual(['p>a', 'a>r', 'r>a']);
    const [first, middle, last] = para.transitions;
    expect(middle!.mean).toBeCloseTo(300, 0);
    expect(middle!.mean).toBeGreaterThan(first!.mean);
    expect(middle!.mean).toBeGreaterThan(last!.mean);
    expect(middle!.share).toBeGreaterThan(0.5);
    expect(para.median).toBeCloseTo(480, 0);
  });

  test('a correction keeps the clean prefix and drops the fixed tail', () => {
    const session = new Session();
    for (let i = 0; i < 8; i++) {
      session.key('c', 100).key('a', 100).key('z', 100).backspace(400).key('s', 150).key('a', 100);
      session.key(' ', 100);
    }
    session.end();

    expect(session.find('ca')?.count).toBe(8);
    expect(session.find('caz')).toBeUndefined();
    expect(session.find('az')).toBeUndefined();
  });

  test('hesitations never enter the timings', () => {
    const session = new Session();
    for (let i = 0; i < 10; i++) session.key('q', 100).key('u', 100).key('e', 100).key(' ', 100);
    // One long stall in the middle of a word must not be recorded.
    session.key('q', 100).key('u', 3000).key('e', 100).end();

    const qu = session.find('qu')!;
    expect(qu.count).toBe(10);
    expect(qu.max).toBeLessThan(200);
  });

  test('accented characters are profiled like any other', () => {
    const session = new Session();
    for (let i = 0; i < 10; i++) session.word('mañana', 100).word('árbol', 100);
    session.end();

    expect(session.find('aña')?.count).toBe(10);
    expect(session.find('ár')?.count).toBe(10);
    expect(session.find('árbo')?.n).toBe(4);
  });

  test('the summary reports a plausible WPM', () => {
    const session = new Session();
    // A steady 100 ms between keys is 120 WPM by the standard 5-character word.
    for (let i = 0; i < 20; i++) session.word('casa', 100).word('para', 100);
    session.end();

    const baseline = computeBaseline(session.store);
    const summary = summarize(session.store, session.stats(), baseline);
    expect(summary.impliedWpm).toBeCloseTo(120, 0);
    expect(summary.baseline.reliable).toBe(true);
    expect(summary.uniqueGrams[2]).toBeGreaterThan(0);
    expect(summary.uniqueGrams[4]).toBeGreaterThan(0);
  });

  test('the profile exports, re-imports and tabulates', () => {
    const session = new Session();
    for (let i = 0; i < 10; i++) session.word('mañana', 120);
    session.end();

    const restored = parseExport(JSON.stringify(buildExport(session.store, DEFAULT_SETTINGS)));
    expect(restored.store.grams).toEqual(session.store.grams);

    const csv = toCsv(session.stats());
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(session.stats().length + 1);
    expect(csv).toContain('aña');
    expect(csv).toContain('a>ñ');
  });

  test('storage stays bounded across a long session', () => {
    const session = new Session();
    const letters = 'abcdefghijklmnopqrstuvwxyzñáéíóú';
    for (let i = 0; i < 400; i++) {
      const word = [0, 1, 2, 3].map((k) => letters[(i * 7 + k * 5) % letters.length]!).join('');
      // A common word alongside the varied ones, so one n-gram far outgrows
      // the sample window and its ring buffer has to wrap.
      session.word(word, 100).word('para', 100);
    }
    session.end();

    const perGram = Object.values(session.store.grams);
    expect(perGram.length).toBeLessThanOrEqual(OPTS.maxGrams);
    for (const record of perGram) {
      expect(record.recent.length).toBeLessThanOrEqual(OPTS.recentWindow);
    }
    // Records stay flat regardless of how many observations they absorbed.
    const busiest = perGram.reduce((a, b) => (a.count > b.count ? a : b));
    expect(busiest.count).toBeGreaterThan(OPTS.recentWindow);
    expect(JSON.stringify(busiest).length).toBeLessThan(600);
  });
});
