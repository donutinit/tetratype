/**
 * Inline SVG charts.
 *
 * Small enough to hand-roll: three shapes, no dependency, and everything drawn
 * with theme variables so the charts follow the page rather than fighting it.
 */

import { escapeHtml } from './table';

export interface BarPoint {
  label: string;
  value: number;
  /** Secondary text shown in the tooltip. */
  detail?: string;
  /** Draws this bar in the accent colour. */
  highlight?: boolean;
}

export interface BarOptions {
  format: (value: number) => string;
  /** Upper bound of the scale. Defaults to the largest value present. */
  max?: number;
  /** Message shown instead of the chart when there is nothing to draw. */
  empty?: string;
}

const EMPTY_MESSAGE = 'Not enough data yet';

function emptyState(message: string): string {
  return `<p class="chart-empty">${escapeHtml(message)}</p>`;
}

/**
 * A column chart with the value written above each bar.
 *
 * Laid out with flexbox rather than SVG so the labels stay selectable and wrap
 * sensibly on a narrow window.
 */
export function barChart(points: readonly BarPoint[], opts: BarOptions): string {
  if (points.length === 0) return emptyState(opts.empty ?? EMPTY_MESSAGE);
  const max = opts.max ?? Math.max(...points.map((p) => p.value), 0);
  const scale = max > 0 ? max : 1;

  const bars = points
    .map((point) => {
      const height = Math.max(2, (point.value / scale) * 100);
      const title = point.detail ? `${point.label} — ${point.detail}` : point.label;
      return `<div class="chart-col" title="${escapeHtml(title)}">
        <span class="chart-value">${escapeHtml(opts.format(point.value))}</span>
        <div class="chart-bar${point.highlight ? ' is-highlight' : ''}" style="height:${height.toFixed(1)}%"></div>
        <span class="chart-label">${escapeHtml(point.label)}</span>
      </div>`;
    })
    .join('');

  return `<div class="chart-bars">${bars}</div>`;
}

export interface Series {
  name: string;
  /** A CSS colour, normally a theme variable. */
  color: string;
  values: number[];
  format: (value: number) => string;
}

export interface LineOptions {
  labels: string[];
  empty?: string;
}

/** Maps a series onto the drawing box, scaled to its own range. */
function polyline(values: readonly number[], width: number, height: number, pad: number): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;

  return values
    .map((value, i) => {
      const x = pad + i * step;
      const y = height - pad - ((value - min) / span) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/**
 * A multi-series line chart where each series is scaled to its own range.
 *
 * WPM and accuracy live on scales that share nothing, so plotting them against
 * a single axis would flatten one of them. Each line is normalised separately
 * and the legend carries the actual range, which keeps both shapes readable.
 */
export function lineChart(series: readonly Series[], opts: LineOptions): string {
  const usable = series.filter((s) => s.values.length > 1);
  if (usable.length === 0) return emptyState(opts.empty ?? EMPTY_MESSAGE);

  const width = 640;
  const height = 160;
  const pad = 12;

  const lines = usable
    .map(
      (s) =>
        `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"
           stroke-linecap="round" points="${polyline(s.values, width, height, pad)}" />`,
    )
    .join('');

  const legend = usable
    .map((s) => {
      const min = Math.min(...s.values);
      const max = Math.max(...s.values);
      const last = s.values[s.values.length - 1] ?? 0;
      return `<span class="legend-item">
        <span class="legend-swatch" style="background:${s.color}"></span>
        ${escapeHtml(s.name)}
        <b>${escapeHtml(s.format(last))}</b>
        <span class="muted">${escapeHtml(s.format(min))}–${escapeHtml(s.format(max))}</span>
      </span>`;
    })
    .join('');

  const first = opts.labels[0] ?? '';
  const lastLabel = opts.labels[opts.labels.length - 1] ?? '';

  return `<div class="chart-legend">${legend}</div>
    <svg class="chart-line" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"
         role="img" aria-label="Trend over time">${lines}</svg>
    <div class="chart-axis"><span>${escapeHtml(first)}</span><span>${escapeHtml(lastLabel)}</span></div>`;
}
