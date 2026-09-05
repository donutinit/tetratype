import { describe, expect, test } from 'bun:test';
import {
  displayGram,
  graphemes,
  isSingleGrapheme,
  isWhitespace,
  normalize,
} from '../src/core/text';

describe('normalize', () => {
  test('composes a dead-key accent into a single grapheme', () => {
    // A dead key can emit the base letter plus a combining acute (U+0301)
    // instead of the precomposed character. Both must land in one bucket.
    const decomposed = 'a\u0301';
    expect(decomposed).not.toBe('\u00e1');
    expect(normalize(decomposed)).toBe('\u00e1');
    expect(normalize(decomposed).length).toBe(1);
  });

  test('leaves already-composed Spanish characters untouched', () => {
    for (const char of ['ñ', 'á', 'é', 'í', 'ó', 'ú', 'ü', 'Ñ', '¿', '¡']) {
      expect(normalize(char)).toBe(char);
    }
  });
});

describe('graphemes', () => {
  test('splits Spanish text into user-perceived characters', () => {
    expect(graphemes('mañana')).toEqual(['m', 'a', 'ñ', 'a', 'n', 'a']);
  });

  test('keeps a combining accent attached to its base letter', () => {
    expect(graphemes('e\u0301')).toEqual(['e\u0301']);
    expect(graphemes('n\u0303an\u0303a')).toHaveLength(4);
  });

  test('returns an empty array for empty input', () => {
    expect(graphemes('')).toEqual([]);
  });
});

describe('isSingleGrapheme', () => {
  test.each([
    ['a', true],
    ['ñ', true],
    ['á', true],
    ['e\u0301', true],
    ['', false],
    ['ab', false],
    ['ñá', false],
  ])('%p -> %p', (input, expected) => {
    expect(isSingleGrapheme(input as string)).toBe(expected);
  });
});

describe('isWhitespace', () => {
  test('detects the characters that delimit runs', () => {
    expect(isWhitespace(' ')).toBe(true);
    expect(isWhitespace('\t')).toBe(true);
    expect(isWhitespace('\n')).toBe(true);
    expect(isWhitespace('a')).toBe(false);
    expect(isWhitespace('ñ')).toBe(false);
  });
});

describe('displayGram', () => {
  test('makes whitespace visible without altering letters', () => {
    expect(displayGram('a b')).toBe('a␣b');
    expect(displayGram('para')).toBe('para');
  });
});
