/**
 * Everything that knows about Monkeytype's DOM lives here.
 *
 * Two jobs: decide whether an event belongs to the typing test (nothing else on
 * the site is ever read), and notice when Monkeytype marks a letter wrong.
 * Both degrade to "don't know" if the site's markup changes, which disables the
 * feature rather than producing wrong data.
 */

import { isSingleGrapheme, normalize } from '../core/text';

/*
 * The structure this module relies on, as Monkeytype serves it:
 *
 *   div#typingTest > div#wordsWrapper > textarea#wordsInput
 *                                     > div#words > div.word > letter
 *
 * Only the ids and the letter classes are load-bearing; the nesting is not.
 */

/** The offscreen textarea Monkeytype focuses while a test is running. */
const WORDS_INPUT = '#wordsInput';
/** Container for the test itself, used to scope the fallback check. */
const TEST_CONTAINER = '#typingTest';
/** The active word, whose letters carry correctness classes. */
const ACTIVE_WORD = '#words .word.active';
/** Classes Monkeytype puts on a letter you got wrong or added extra. */
const WRONG_LETTER = '.incorrect, .extra';

/** Classes marking a letter you have already reached. */
const CONSUMED_LETTER = '.correct, .incorrect, .extra, .dead, .corrected';

/**
 * True only for the Monkeytype typing input.
 *
 * This is the whole privacy boundary: search boxes, the login form and every
 * other field on the site fail this check, so their keystrokes are never seen.
 */
export function isTypingInput(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.matches(WORDS_INPUT)) return true;
  // Tolerate a renamed input as long as it is still inside the test container.
  const editable = target.matches('input, textarea');
  return editable && target.closest(TEST_CONTAINER) !== null;
}

/** The element holding the word currently being typed, if we can find it. */
export function activeWord(): Element | null {
  return document.querySelector(ACTIVE_WORD);
}

/**
 * The character the test is waiting for.
 *
 * Monkeytype renders letters you have not reached yet with no state class, so
 * the first unclassed letter in the active word is the one you are about to
 * type. Reading it during `beforeinput` — before the site has processed the
 * keystroke — gives the expected character with no lag at all.
 *
 * Deliberately does not read the letter *under* the cursor once it is marked
 * incorrect: what that element contains depends on the reader's `indicateTypos`
 * setting, and would be the typed character rather than the expected one.
 *
 * Returns null whenever the answer is not a single plain character, which
 * covers tabs, newlines and any funbox that renders icons instead of text.
 */
export function expectedChar(word: Element | null): string | null {
  if (!word) return null;
  for (const letter of word.querySelectorAll('letter')) {
    if (letter.matches(CONSUMED_LETTER)) continue;
    const text = normalize(letter.textContent ?? '');
    return isSingleGrapheme(text) ? text : null;
  }
  return null;
}

/**
 * Counts letters Monkeytype has flagged in the active word.
 *
 * Returns -1 when the markup is not recognised, which switches error detection
 * off instead of guessing.
 */
export function countWrongLetters(word: Element | null): number {
  if (!word) return -1;
  return word.querySelectorAll(WRONG_LETTER).length;
}
