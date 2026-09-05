import { beforeEach, describe, expect, test } from 'bun:test';
import { activeWord, countWrongLetters, isTypingInput } from '../src/content/monkeytype';

/** Renders a minimal stand-in for Monkeytype's typing test markup. */
function mountTest(): void {
  document.body.innerHTML = `
    <div id="typingTest">
      <div id="wordsWrapper">
        <textarea id="wordsInput" autocomplete="off"></textarea>
        <div id="words">
          <div class="word"><letter class="correct">l</letter></div>
          <div class="word active"><letter class="correct">c</letter></div>
        </div>
      </div>
    </div>
    <form id="login">
      <input id="email" type="email" />
      <input id="password" type="password" />
    </form>
    <input id="site-search" type="search" />
  `;
}

beforeEach(mountTest);

describe('isTypingInput', () => {
  test('accepts the Monkeytype words input', () => {
    expect(isTypingInput(document.getElementById('wordsInput'))).toBe(true);
  });

  test('refuses the login form', () => {
    expect(isTypingInput(document.getElementById('email'))).toBe(false);
    expect(isTypingInput(document.getElementById('password'))).toBe(false);
  });

  test('refuses an unrelated search box', () => {
    expect(isTypingInput(document.getElementById('site-search'))).toBe(false);
  });

  test('refuses the document and the body', () => {
    expect(isTypingInput(document.body)).toBe(false);
    expect(isTypingInput(document)).toBe(false);
    expect(isTypingInput(null)).toBe(false);
  });

  test('accepts a renamed input that is still inside the test container', () => {
    const input = document.createElement('input');
    input.id = 'typingArea';
    document.getElementById('typingTest')?.appendChild(input);
    expect(isTypingInput(input)).toBe(true);
  });

  test('refuses an input outside the test container even if focused', () => {
    const outside = document.getElementById('site-search') as HTMLInputElement;
    outside.focus();
    expect(isTypingInput(outside)).toBe(false);
  });
});

describe('countWrongLetters', () => {
  test('counts letters flagged incorrect or extra', () => {
    const word = activeWord();
    word?.insertAdjacentHTML('beforeend', '<letter class="incorrect">x</letter>');
    word?.insertAdjacentHTML('beforeend', '<letter class="extra">y</letter>');
    expect(countWrongLetters(word)).toBe(2);
  });

  test('counts zero for a clean word', () => {
    expect(countWrongLetters(activeWord())).toBe(0);
  });

  test('reports -1 when the markup is unrecognised', () => {
    document.body.innerHTML = '<div id="typingTest"></div>';
    expect(activeWord()).toBeNull();
    expect(countWrongLetters(null)).toBe(-1);
  });
});
