/**
 * Unicode helpers.
 *
 * Tetratype is used with Spanish (and any other) layouts, so every character
 * that reaches the statistics layer is NFC-normalized first. That way a dead
 * key producing `a` + U+0301 and a precomposed `á` are counted as the same
 * grapheme instead of drifting into two separate buckets.
 */

/** Matches a single whitespace character. */
const WHITESPACE = /^\s$/u;

/**
 * Code points that belong to the preceding character rather than starting a new
 * one. `\p{M}` covers combining accents and variation selectors; U+200D is the
 * zero-width joiner, which is a format character and needs listing separately.
 */
const TRAILING_MARK = /^(?:\p{M}|\u{200D})$/u;

let segmenter: Intl.Segmenter | null | undefined;

function getSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  return segmenter;
}

/** Normalizes text to NFC, tolerating engines without `String#normalize`. */
export function normalize(input: string): string {
  return typeof input.normalize === 'function' ? input.normalize('NFC') : input;
}

/**
 * Splits text into user-perceived characters.
 *
 * Uses `Intl.Segmenter` when available (Firefox 125+) and otherwise falls back
 * to code-point splitting that re-attaches combining marks, which covers every
 * accent and dead-key combination a keyboard layout can emit.
 */
export function graphemes(input: string): string[] {
  if (input === '') return [];
  const seg = getSegmenter();
  if (seg) return Array.from(seg.segment(input), (part) => part.segment);

  const out: string[] = [];
  for (const codePoint of Array.from(input)) {
    const last = out.length - 1;
    if (last >= 0 && TRAILING_MARK.test(codePoint)) {
      out[last] += codePoint;
    } else {
      out.push(codePoint);
    }
  }
  return out;
}

/**
 * True for a code point that modifies the character before it.
 *
 * Some layouts deliver a dead-key accent as its own input event instead of a
 * precomposed letter, so the capture layer folds these into the previous
 * keystroke rather than treating them as characters of their own.
 */
export function isCombiningMark(char: string): boolean {
  return TRAILING_MARK.test(char);
}

/** True when `input` is exactly one user-perceived character. */
export function isSingleGrapheme(input: string): boolean {
  return input.length > 0 && graphemes(input).length === 1;
}

/** True for spaces, tabs and newlines, which delimit runs by default. */
export function isWhitespace(char: string): boolean {
  return WHITESPACE.test(char);
}

/**
 * Renders a grapheme for display, making invisible characters legible.
 *
 * Only used by the dashboard; the stored data always keeps the real character.
 */
export function displayChar(char: string): string {
  if (char === ' ') return '␣';
  if (char === '\t') return '⇥';
  if (char === '\n') return '⏎';
  return char;
}

/** Renders an n-gram for display, one grapheme at a time. */
export function displayGram(gram: string): string {
  return graphemes(gram).map(displayChar).join('');
}
