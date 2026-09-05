import { describe, expect, test } from 'bun:test';
import {
  LAYOUT_IDS,
  type LayoutId,
  classifyGram,
  classifyTransition,
  getLayout,
  keysFor,
} from '../src/core/layout';

const es = getLayout('qwerty-es');
const us = getLayout('qwerty-us');

const shape = (a: string, b: string, layout = es) => classifyTransition(a, b, layout).shape;

describe('key placement', () => {
  test('assigns home-row letters to the expected fingers', () => {
    expect(es.keys.get('a')).toMatchObject({ hand: 'left', finger: 'pinky', row: 2 });
    expect(es.keys.get('s')).toMatchObject({ hand: 'left', finger: 'ring' });
    expect(es.keys.get('d')).toMatchObject({ hand: 'left', finger: 'middle' });
    expect(es.keys.get('f')).toMatchObject({ hand: 'left', finger: 'index' });
    expect(es.keys.get('j')).toMatchObject({ hand: 'right', finger: 'index' });
    expect(es.keys.get('k')).toMatchObject({ hand: 'right', finger: 'middle' });
    expect(es.keys.get('l')).toMatchObject({ hand: 'right', finger: 'ring' });
  });

  test('marks the centre columns as lateral stretches', () => {
    expect(es.keys.get('g')?.stretch).toBe(true);
    expect(es.keys.get('h')?.stretch).toBe(true);
    expect(es.keys.get('t')?.stretch).toBe(true);
    expect(es.keys.get('f')?.stretch).toBe(false);
  });

  test('offsets the number row so digits land on the right fingers', () => {
    expect(es.keys.get('1')).toMatchObject({ hand: 'left', finger: 'pinky' });
    expect(es.keys.get('4')).toMatchObject({ hand: 'left', finger: 'index' });
    expect(es.keys.get('7')).toMatchObject({ hand: 'right', finger: 'index' });
    expect(es.keys.get('0')).toMatchObject({ hand: 'right', finger: 'pinky' });
  });

  test('places the Spanish-only keys on the right pinky', () => {
    expect(es.keys.get('ñ')).toMatchObject({ hand: 'right', finger: 'pinky', row: 2 });
    expect(es.keys.get('´')).toMatchObject({ hand: 'right', finger: 'pinky' });
    expect(us.keys.get('ñ')).toBeUndefined();
  });

  test('every layout maps the whole home row', () => {
    for (const id of LAYOUT_IDS) {
      const layout = getLayout(id as LayoutId);
      const home = [...layout.keys.values()].filter((k) => k.row === 2);
      expect(home.length).toBeGreaterThanOrEqual(10);
    }
  });
});

describe('keysFor', () => {
  test('a plain letter is one press', () => {
    expect(keysFor('a', es)).toHaveLength(1);
  });

  test('an accented vowel costs a dead key plus the vowel', () => {
    const keys = keysFor('á', es);
    expect(keys).toHaveLength(2);
    expect(keys?.[0]?.char).toBe('´');
    expect(keys?.[1]?.char).toBe('a');
  });

  test('a capital reuses its base key and records the shift', () => {
    const keys = keysFor('A', es);
    expect(keys).toHaveLength(1);
    expect(keys?.[0]).toMatchObject({ finger: 'pinky', shift: true });
  });

  test('returns null for a character not on the layout', () => {
    expect(keysFor('ñ', us)).toBeNull();
    expect(keysFor('★', es)).toBeNull();
  });
});

describe('classifyTransition', () => {
  test('detects same-finger bigrams', () => {
    expect(shape('e', 'd')).toBe('same-finger');
    expect(shape('u', 'y')).toBe('same-finger');
    expect(shape('a', 'q')).toBe('same-finger');
  });

  test('a repeated character is a double tap, not a same-finger jump', () => {
    expect(shape('a', 'a')).toBe('same-key');
  });

  test('detects alternation between hands', () => {
    expect(shape('a', 'l')).toBe('alternate');
    expect(shape('f', 'j')).toBe('alternate');
  });

  test('names roll direction by movement towards the index finger', () => {
    expect(shape('a', 'd')).toBe('inward-roll');
    expect(shape('d', 'a')).toBe('outward-roll');
    expect(shape('l', 'j')).toBe('inward-roll');
    expect(shape('j', 'l')).toBe('outward-roll');
  });

  test('detects a scissor between neighbouring fingers on distant rows', () => {
    // `x` is bottom-row ring, `e` is top-row middle: two rows apart.
    expect(shape('x', 'e')).toBe('scissor');
  });

  test('reports the rows crossed', () => {
    expect(classifyTransition('q', 'z', es).rowJump).toBe(2);
    expect(classifyTransition('a', 's', es).rowJump).toBe(0);
  });

  test('flags a transition into an accented vowel as a dead-key move', () => {
    // The measured move is towards the dead key, which lives on the right pinky.
    const fromLeft = classifyTransition('s', 'á', es);
    expect(fromLeft.viaDeadKey).toBe(true);
    expect(fromLeft.sameHand).toBe(false);

    // `m` is already on the right hand, so reaching the dead key is a roll.
    const fromRight = classifyTransition('m', 'á', es);
    expect(fromRight.viaDeadKey).toBe(true);
    expect(fromRight.sameHand).toBe(true);
    expect(fromRight.shape).toBe('outward-roll');
  });

  test('measures from the last press of a composed character', () => {
    // `á` ends on `a`, so the next move starts from the left pinky.
    expect(classifyTransition('á', 's', es).shape).toBe('inward-roll');
  });

  test('is unknown when a character is off the layout', () => {
    expect(shape('a', 'ñ', us)).toBe('unknown');
  });
});

describe('classifyGram', () => {
  test('counts same-finger jumps inside a longer n-gram', () => {
    const result = classifyGram([...'ded'], es);
    expect(result.sameFingerCount).toBe(2);
    expect(result.label).toBe('same finger');
  });

  test('labels a fully alternating n-gram', () => {
    const result = classifyGram([...'ala'], es);
    expect(result.alternationCount).toBe(2);
    expect(result.label).toBe('alternating');
  });

  test('detects a redirect when a same-hand roll reverses', () => {
    // a -> d inward, d -> s outward, all left hand.
    const result = classifyGram([...'ads'], es);
    expect(result.redirectCount).toBe(1);
    expect(result.label).toBe('redirect');
  });

  test('does not count a direction change across hands as a redirect', () => {
    expect(classifyGram([...'adl'], es).redirectCount).toBe(0);
  });

  test('counts the dead keys an n-gram needs', () => {
    expect(classifyGram([...'más'], es).deadKeyCount).toBe(1);
    expect(classifyGram([...'ánó'], es).deadKeyCount).toBe(2);
  });

  test('reports the largest row jump', () => {
    expect(classifyGram([...'qaz'], es).maxRowJump).toBe(1);
    expect(classifyGram([...'qz'], es).maxRowJump).toBe(2);
  });

  test('marks an n-gram unknown when a character is off the layout', () => {
    const result = classifyGram([...'añ'], us);
    expect(result.known).toBe(false);
    expect(result.label).toBe('unmapped');
  });

  test('handles a single character with no transitions', () => {
    const result = classifyGram(['a'], es);
    expect(result.transitions).toEqual([]);
    expect(result.label).toBe('—');
  });
});
