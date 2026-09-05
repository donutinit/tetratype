/**
 * Everything that knows about Monkeytype's DOM lives here.
 *
 * Two jobs: decide whether an event belongs to the typing test (nothing else on
 * the site is ever read), and notice when Monkeytype marks a letter wrong.
 * Both degrade to "don't know" if the site's markup changes, which disables the
 * feature rather than producing wrong data.
 */

/** The hidden input Monkeytype focuses while a test is running. */
const WORDS_INPUT = '#wordsInput';
/** Container for the test itself, used to scope the fallback check. */
const TEST_CONTAINER = '#typingTest';
/** The active word, whose letters carry correctness classes. */
const ACTIVE_WORD = '#words .word.active';
/** Classes Monkeytype puts on a letter you got wrong or added extra. */
const WRONG_LETTER = '.incorrect, .extra';

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
 * Counts letters Monkeytype has flagged in the active word.
 *
 * Returns -1 when the markup is not recognised, which switches error detection
 * off instead of guessing.
 */
export function countWrongLetters(word: Element | null): number {
  if (!word) return -1;
  return word.querySelectorAll(WRONG_LETTER).length;
}
