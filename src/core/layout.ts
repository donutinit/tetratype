/**
 * Physical keyboard modelling.
 *
 * Latency alone says a combination is slow; it cannot say why. Mapping each
 * character onto a hand, a finger and a row turns "`br` is slow" into "`br` is
 * a same-finger bigram", which is the difference between a number and something
 * you can act on.
 *
 * Geometry is derived from column position rather than hand-written per key, so
 * a layout is just its rows and the same finger rule applies to all of them.
 */

export type Hand = 'left' | 'right';
export type Finger = 'pinky' | 'ring' | 'middle' | 'index';

/** Where a character sits on the board. */
export interface KeyPos {
  char: string;
  hand: Hand;
  finger: Finger;
  /** 0 = number row, 1 = top, 2 = home, 3 = bottom. */
  row: number;
  /** Column within the row, before the number row's one-key offset. */
  col: number;
  /** True when the character needs Shift. */
  shift: boolean;
  /** True for the centre columns an index finger has to reach sideways for. */
  stretch: boolean;
}

export type LayoutId = 'qwerty-es' | 'qwerty-us' | 'colemak' | 'dvorak';

export const LAYOUT_IDS: readonly LayoutId[] = [
  'qwerty-es',
  'qwerty-us',
  'colemak',
  'dvorak',
] as const;

interface LayoutSpec {
  name: string;
  /** `[unshifted, shifted]` per row, number row first. */
  rows: [string, string][];
  /**
   * Characters produced by a dead key followed by a base key, as
   * `composed -> [deadKeyChar, baseChar]`. Typing them costs two presses.
   */
  composed?: Record<string, [string, string]>;
}

/** Left-hand columns 0-4, then right-hand columns 5 and up. */
const LEFT_FINGERS: readonly Finger[] = ['pinky', 'ring', 'middle', 'index', 'index'];
const RIGHT_FINGERS: readonly Finger[] = ['index', 'index', 'middle', 'ring', 'pinky'];

/** How far the fingers sit from the edge, for roll direction. */
const FINGER_ORDER: Record<Finger, number> = { pinky: 0, ring: 1, middle: 2, index: 3 };

const ACCENTS: Record<string, [string, string]> = {
  á: ['´', 'a'],
  é: ['´', 'e'],
  í: ['´', 'i'],
  ó: ['´', 'o'],
  ú: ['´', 'u'],
  ü: ['¨', 'u'],
  Á: ['´', 'A'],
  É: ['´', 'E'],
  Í: ['´', 'I'],
  Ó: ['´', 'O'],
  Ú: ['´', 'U'],
  Ü: ['¨', 'U'],
};

const SPECS: Record<LayoutId, LayoutSpec> = {
  'qwerty-es': {
    name: 'QWERTY (Spanish)',
    rows: [
      ["º1234567890'¡", 'ª!"·$%&/()=?¿'],
      ['qwertyuiop`+', 'QWERTYUIOP^*'],
      ['asdfghjklñ´ç', 'ASDFGHJKLÑ¨Ç'],
      ['zxcvbnm,.-', 'ZXCVBNM;:_'],
    ],
    composed: ACCENTS,
  },
  'qwerty-us': {
    name: 'QWERTY (US)',
    rows: [
      ['`1234567890-=', '~!@#$%^&*()_+'],
      ['qwertyuiop[]\\', 'QWERTYUIOP{}|'],
      ["asdfghjkl;'", 'ASDFGHJKL:"'],
      ['zxcvbnm,./', 'ZXCVBNM<>?'],
    ],
  },
  colemak: {
    name: 'Colemak',
    rows: [
      ['`1234567890-=', '~!@#$%^&*()_+'],
      ['qwfpgjluy;[]\\', 'QWFPGJLUY:{}|'],
      ["arstdhneio'", 'ARSTDHNEIO"'],
      ['zxcvbkm,./', 'ZXCVBKM<>?'],
    ],
  },
  dvorak: {
    name: 'Dvorak',
    rows: [
      ['`1234567890[]', '~!@#$%^&*(){}'],
      ["',.pyfgcrl/=", '"<>PYFGCRL?+'],
      ['aoeuidhtns-', 'AOEUIDHTNS_'],
      [';qjkxbmwvz', ':QJKXBMWVZ'],
    ],
  },
};

/** The number row sits one key to the right of the letter rows. */
function effectiveColumn(row: number, col: number): number {
  return row === 0 ? Math.max(0, col - 1) : col;
}

function place(char: string, row: number, col: number, shift: boolean): KeyPos {
  const effective = effectiveColumn(row, col);
  if (effective <= 4) {
    return {
      char,
      hand: 'left',
      finger: LEFT_FINGERS[effective] ?? 'pinky',
      row,
      col: effective,
      shift,
      stretch: effective === 4,
    };
  }
  const offset = effective - 5;
  return {
    char,
    hand: 'right',
    finger: RIGHT_FINGERS[Math.min(offset, RIGHT_FINGERS.length - 1)] ?? 'pinky',
    row,
    col: effective,
    shift,
    stretch: offset === 0,
  };
}

export interface Layout {
  id: LayoutId;
  name: string;
  keys: Map<string, KeyPos>;
  composed: Map<string, [string, string]>;
}

const cache = new Map<LayoutId, Layout>();

export function getLayout(id: LayoutId): Layout {
  const cached = cache.get(id);
  if (cached) return cached;

  const spec = SPECS[id];
  const keys = new Map<string, KeyPos>();
  spec.rows.forEach(([unshifted, shifted], row) => {
    [...unshifted].forEach((char, col) => keys.set(char, place(char, row, col, false)));
    [...shifted].forEach((char, col) => {
      if (!keys.has(char)) keys.set(char, place(char, row, col, true));
    });
  });

  const layout: Layout = {
    id,
    name: spec.name,
    keys,
    composed: new Map(Object.entries(spec.composed ?? {})),
  };
  cache.set(id, layout);
  return layout;
}

/**
 * The physical presses a character costs.
 *
 * One key for most characters, two for anything built from a dead key — which
 * is why `á` is genuinely more expensive than `a` and should not be compared
 * against it as though they were the same motion.
 */
export function keysFor(char: string, layout: Layout): KeyPos[] | null {
  const direct = layout.keys.get(char);
  if (direct) return [direct];

  const composed = layout.composed.get(char);
  if (composed) {
    const dead = layout.keys.get(composed[0]);
    const base = layout.keys.get(composed[1]) ?? layout.keys.get(composed[1].toLowerCase());
    if (dead && base) return [dead, base];
  }

  const lower = char.toLowerCase();
  if (lower !== char) {
    const shifted = layout.keys.get(lower);
    if (shifted) return [{ ...shifted, char, shift: true }];
  }
  return null;
}

export type TransitionShape =
  | 'same-key'
  | 'same-finger'
  | 'scissor'
  | 'inward-roll'
  | 'outward-roll'
  | 'alternate'
  | 'unknown';

export interface TransitionAnalysis {
  from: string;
  to: string;
  shape: TransitionShape;
  sameHand: boolean;
  /** Rows crossed between the two keys. */
  rowJump: number;
  /** Either key is in a column an index finger must reach for. */
  stretch: boolean;
  /** The destination needs a dead key first, so it costs an extra press. */
  viaDeadKey: boolean;
}

const UNKNOWN_TRANSITION: Omit<TransitionAnalysis, 'from' | 'to'> = {
  shape: 'unknown',
  sameHand: false,
  rowJump: 0,
  stretch: false,
  viaDeadKey: false,
};

function shapeOf(a: KeyPos, b: KeyPos): TransitionShape {
  if (a.hand !== b.hand) return 'alternate';
  if (a.row === b.row && a.col === b.col) return 'same-key';
  if (a.finger === b.finger) return 'same-finger';

  const rowJump = Math.abs(a.row - b.row);
  const fingerGap = Math.abs(FINGER_ORDER[a.finger] - FINGER_ORDER[b.finger]);
  // Neighbouring fingers forced onto distant rows: the classic awkward reach.
  if (fingerGap === 1 && rowJump >= 2) return 'scissor';

  return FINGER_ORDER[b.finger] > FINGER_ORDER[a.finger] ? 'inward-roll' : 'outward-roll';
}

/** Classifies the movement from one character to the next. */
export function classifyTransition(from: string, to: string, layout: Layout): TransitionAnalysis {
  const fromKeys = keysFor(from, layout);
  const toKeys = keysFor(to, layout);
  if (!fromKeys?.length || !toKeys?.length) return { from, to, ...UNKNOWN_TRANSITION };

  // The move that matters is from the last press of `from` to the first of `to`.
  const a = fromKeys[fromKeys.length - 1]!;
  const b = toKeys[0]!;

  return {
    from,
    to,
    shape: shapeOf(a, b),
    sameHand: a.hand === b.hand,
    rowJump: Math.abs(a.row - b.row),
    stretch: a.stretch || b.stretch,
    viaDeadKey: toKeys.length > 1,
  };
}

export interface GramShape {
  transitions: TransitionAnalysis[];
  sameFingerCount: number;
  scissorCount: number;
  alternationCount: number;
  deadKeyCount: number;
  /** Same-hand runs that reverse direction, which break a roll's momentum. */
  redirectCount: number;
  maxRowJump: number;
  /** False when any character is missing from the layout. */
  known: boolean;
  /** Short label for the dashboard, naming the dominant difficulty. */
  label: string;
}

/** Names the worst thing happening in the n-gram, for a one-word column. */
function labelFor(transitions: TransitionAnalysis[], redirects: number): string {
  if (transitions.length === 0) return '—';
  if (transitions.some((t) => t.shape === 'unknown')) return 'unmapped';
  if (transitions.some((t) => t.shape === 'same-finger')) return 'same finger';
  if (transitions.some((t) => t.shape === 'scissor')) return 'scissor';
  if (redirects > 0) return 'redirect';
  if (transitions.some((t) => t.viaDeadKey)) return 'dead key';
  if (transitions.every((t) => t.shape === 'alternate')) return 'alternating';
  if (transitions.some((t) => t.shape === 'inward-roll' || t.shape === 'outward-roll')) {
    const inward = transitions.filter((t) => t.shape === 'inward-roll').length;
    const outward = transitions.filter((t) => t.shape === 'outward-roll').length;
    return inward >= outward ? 'inward roll' : 'outward roll';
  }
  return 'repeat';
}

/** Counts same-hand rolls that change direction partway through. */
function countRedirects(transitions: TransitionAnalysis[]): number {
  let redirects = 0;
  for (let i = 1; i < transitions.length; i++) {
    const previous = transitions[i - 1]!;
    const current = transitions[i]!;
    if (!previous.sameHand || !current.sameHand) continue;
    const rolls = ['inward-roll', 'outward-roll'];
    if (!rolls.includes(previous.shape) || !rolls.includes(current.shape)) continue;
    if (previous.shape !== current.shape) redirects++;
  }
  return redirects;
}

/** Describes the physical shape of a whole n-gram. */
export function classifyGram(chars: readonly string[], layout: Layout): GramShape {
  const transitions: TransitionAnalysis[] = [];
  for (let i = 1; i < chars.length; i++) {
    transitions.push(classifyTransition(chars[i - 1]!, chars[i]!, layout));
  }

  const redirectCount = countRedirects(transitions);
  const deadKeyCount =
    transitions.filter((t) => t.viaDeadKey).length +
    (chars.length > 0 && (keysFor(chars[0]!, layout)?.length ?? 0) > 1 ? 1 : 0);

  return {
    transitions,
    sameFingerCount: transitions.filter((t) => t.shape === 'same-finger').length,
    scissorCount: transitions.filter((t) => t.shape === 'scissor').length,
    alternationCount: transitions.filter((t) => t.shape === 'alternate').length,
    deadKeyCount,
    redirectCount,
    maxRowJump: transitions.reduce((max, t) => Math.max(max, t.rowJump), 0),
    known: transitions.every((t) => t.shape !== 'unknown'),
    label: labelFor(transitions, redirectCount),
  };
}
