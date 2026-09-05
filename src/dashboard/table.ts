import type { NgramStats } from '../core/stats';
import { displayGram } from '../core/text';
import { ms } from './format';

export type SortKey =
  | 'gram'
  | 'count'
  | 'median'
  | 'mean'
  | 'p90'
  | 'min'
  | 'max'
  | 'msPerTransition'
  | 'cv'
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

export const COLUMNS: Column[] = [
  {
    key: 'gram',
    label: 'N-gram',
    title: 'The characters, in order',
    defaultDescending: false,
    render: (s) => `<span class="caret">▸</span>${escapeHtml(displayGram(s.gram))}`,
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
    key: 'mean',
    label: 'Mean',
    title: 'Lifetime average total duration (ms)',
    defaultDescending: true,
    render: (s) => ms(s.mean),
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
    key: 'max',
    label: 'Worst',
    title: 'Slowest observation ever recorded (ms)',
    defaultDescending: true,
    render: (s) => `<span class="muted">${ms(s.max)}</span>`,
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
  return (a[key] - b[key]) * direction;
}

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
    .map(
      (t, i) => `<tr>
        <td class="step">${i + 1}. ${escapeHtml(t.from)} → ${escapeHtml(t.to)}</td>
        <td>${ms(t.mean, 1)} ms</td>
        <td class="muted">± ${ms(t.sd, 1)}</td>
        <td class="muted">${(t.share * 100).toFixed(0)}% of total</td>
      </tr>`,
    )
    .join('');

  return `<tr class="detail"><td colspan="${columns}">
      <div class="transition-bar">${segments}</div>
      <div class="detail-grid">
        <table>
          <thead>
            <tr><th>Transition</th><th>Mean</th><th>Spread</th><th>Share</th></tr>
          </thead>
          <tbody>
            ${rows}
            <tr>
              <td class="step">Total</td>
              <td>${ms(stat.median, 1)} ms</td>
              <td class="muted">± ${ms(stat.sd, 1)}</td>
              <td class="muted">${stat.count} samples</td>
            </tr>
          </tbody>
        </table>
      </div>
    </td></tr>`;
}

export { escapeHtml };
