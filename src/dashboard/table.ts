import type { TransitionShape } from '../core/layout';
import type { NgramStats } from '../core/stats';
import { displayGram } from '../core/text';
import { ms } from './format';

export type SortKey =
  | 'gram'
  | 'shape'
  | 'count'
  | 'median'
  | 'p90'
  | 'min'
  | 'msPerTransition'
  | 'cv'
  | 'errorRate'
  | 'trendMs'
  | 'contextPenaltyMs'
  | 'impact';

export interface Column {
  key: SortKey;
  label: string;
  title: string;
  /** Sorting a column for the first time should show the interesting end. */
  defaultDescending: boolean;
  render: (stat: NgramStats) => string;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

/** A small inline meter, used for the impact column. */
function meter(fraction: number): string {
  const width = Math.max(0, Math.min(100, fraction * 100));
  return `<span class="bar"><span style="width:${width.toFixed(1)}%"></span></span>`;
}

/** Colours the coefficient of variation: low is steady, high is erratic. */
function cvClass(cv: number): string {
  if (cv < 0.25) return 'good';
  if (cv < 0.45) return '';
  return 'warn';
}

/** Difficulties worth colouring in the shape column. */
const HARD_SHAPES = new Set(['same finger', 'scissor', 'redirect']);

function shapeCell(stat: NgramStats): string {
  const label = stat.shape.label;
  const cls = HARD_SHAPES.has(label) ? 'warn' : label === 'unmapped' ? 'muted' : '';
  return `<span class="tag ${cls}">${escapeHtml(label)}</span>`;
}

function errorCell(stat: NgramStats): string {
  if (stat.errorRate === null) return '<span class="muted">—</span>';
  const percent = stat.errorRate * 100;
  const cls = percent >= 8 ? 'bad' : percent >= 3 ? 'warn' : 'good';
  return `<span class="${cls}">${percent.toFixed(1)}%</span>`;
}

/** Shows which way an n-gram is moving: negative milliseconds are progress. */
function trendCell(stat: NgramStats): string {
  if (stat.trendMs === 0) return '<span class="muted">—</span>';
  const faster = stat.trendMs < 0;
  const arrow = faster ? '▼' : '▲';
  return `<span class="${faster ? 'good' : 'warn'}">${arrow} ${Math.abs(stat.trendMs).toFixed(0)}</span>`;
}

function contextCell(stat: NgramStats): string {
  if (stat.n !== 2 || stat.contextPenaltyMs === 0) return '<span class="muted">—</span>';
  const worse = stat.contextPenaltyMs > 0;
  return `<span class="${worse ? 'warn' : 'good'}">${worse ? '+' : ''}${stat.contextPenaltyMs.toFixed(0)}</span>`;
}

export const COLUMNS: Column[] = [
  {
    key: 'gram',
    label: 'N-gram',
    title: 'The characters, in order',
    defaultDescending: false,
    render: (s) => `<span class="caret">▸</span>${escapeHtml(displayGram(s.gram))}`,
  },
  {
    key: 'shape',
    label: 'Shape',
    title: 'What this asks of your hands, from the keyboard layout',
    defaultDescending: false,
    render: shapeCell,
  },
  {
    key: 'count',
    label: 'Samples',
    title: 'How many times this n-gram was observed',
    defaultDescending: true,
    render: (s) => String(s.count),
  },
  {
    key: 'median',
    label: 'Median',
    title: 'Median total duration over the recent window (ms)',
    defaultDescending: true,
    render: (s) => ms(s.median),
  },
  {
    key: 'p90',
    label: 'p90',
    title: '90th percentile over the recent window (ms)',
    defaultDescending: true,
    render: (s) => ms(s.p90),
  },
  {
    key: 'min',
    label: 'Best',
    title: 'Fastest observation ever recorded (ms)',
    defaultDescending: false,
    render: (s) => `<span class="good">${ms(s.min)}</span>`,
  },
  {
    key: 'msPerTransition',
    label: 'ms/step',
    title: 'Median divided by the number of key transitions',
    defaultDescending: true,
    render: (s) => ms(s.msPerTransition, 1),
  },
  {
    key: 'cv',
    label: 'Var',
    title: 'Coefficient of variation: spread relative to the mean',
    defaultDescending: true,
    render: (s) => `<span class="${cvClass(s.cv)}">${s.cv.toFixed(2)}</span>`,
  },
  {
    key: 'errorRate',
    label: 'Miss',
    title: 'Chance of fumbling this n-gram somewhere',
    defaultDescending: true,
    render: errorCell,
  },
  {
    key: 'trendMs',
    label: 'Trend',
    title: 'Recent speed against your longer-run average: down is faster',
    defaultDescending: false,
    render: trendCell,
  },
  {
    key: 'contextPenaltyMs',
    label: 'Context',
    title: 'Extra milliseconds this pair costs inside longer n-grams',
    defaultDescending: true,
    render: contextCell,
  },
  {
    key: 'impact',
    label: 'Impact',
    title: 'Time lost to this n-gram, scaled against the worst of its length',
    defaultDescending: true,
    render: (s) => `${meter(s.impact / 100)}${s.impact.toFixed(0)}`,
  },
];

export function compare(a: NgramStats, b: NgramStats, key: SortKey, descending: boolean): number {
  const direction = descending ? -1 : 1;
  if (key === 'gram') return a.gram.localeCompare(b.gram) * direction;
  if (key === 'shape') return a.shape.label.localeCompare(b.shape.label) * direction;
  // Untracked error rates sort to the bottom rather than reading as perfect.
  if (key === 'errorRate') return ((a.errorRate ?? -1) - (b.errorRate ?? -1)) * direction;
  return (a[key] - b[key]) * direction;
}

/** Plain-English names for the movement classes. */
const SHAPE_LABELS: Record<TransitionShape, string> = {
  'same-key': 'double tap',
  'same-finger': 'same finger',
  scissor: 'scissor',
  'inward-roll': 'inward roll',
  'outward-roll': 'outward roll',
  alternate: 'alternating',
  unknown: 'unmapped',
};

const HARD_MOVES = new Set<TransitionShape>(['same-finger', 'scissor']);

/** Builds the expanded row showing what happens inside an n-gram. */
export function renderDetail(stat: NgramStats, columns: number): string {
  if (stat.transitions.length === 0) return '';
  const total = stat.transitions.reduce((acc, t) => acc + t.mean, 0) || 1;
  const hues = ['var(--accent)', 'var(--good)', 'var(--warn)'];

  const segments = stat.transitions
    .map((t, i) => {
      const width = (t.mean / total) * 100;
      const color = hues[i % hues.length];
      const label = width > 12 ? `${escapeHtml(t.from)}→${escapeHtml(t.to)}` : '';
      return `<span style="width:${width.toFixed(2)}%;background:${color}" title="${escapeHtml(
        `${t.from} → ${t.to}: ${ms(t.mean, 1)} ms`,
      )}">${label}</span>`;
    })
    .join('');

  const rows = stat.transitions
    .map((t, i) => {
      const move = stat.shape.transitions[i];
      const shapeLabel = move ? SHAPE_LABELS[move.shape] : '';
      const hard = move ? HARD_MOVES.has(move.shape) : false;
      return `<tr>
        <td class="step">${i + 1}. ${escapeHtml(t.from)} → ${escapeHtml(t.to)}</td>
        <td>${ms(t.mean, 1)} ms</td>
        <td class="muted">± ${ms(t.sd, 1)}</td>
        <td class="muted">${(t.share * 100).toFixed(0)}% of total</td>
        <td><span class="tag ${hard ? 'warn' : ''}">${escapeHtml(shapeLabel)}</span></td>
      </tr>`;
    })
    .join('');

  return `<tr class="detail"><td colspan="${columns}">
      <div class="transition-bar">${segments}</div>
      <div class="detail-grid">
        <table>
          <thead>
            <tr><th>Transition</th><th>Mean</th><th>Spread</th><th>Share</th><th>Movement</th></tr>
          </thead>
          <tbody>
            ${rows}
            <tr>
              <td class="step">Total</td>
              <td>${ms(stat.median, 1)} ms</td>
              <td class="muted">± ${ms(stat.sd, 1)}</td>
              <td class="muted">${stat.count} samples</td>
              <td><span class="tag">${escapeHtml(stat.shape.label)}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </td></tr>`;
}

export { escapeHtml };
