/** Presentation helpers shared by the dashboard and popup. */

export function ms(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function int(value: number): string {
  return Math.round(value).toLocaleString();
}

export function pct(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** Formats a byte count for the storage-size card. */
export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} kB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

/** Renders a timestamp as a short relative age. */
export function ago(timestamp: number, now = Date.now()): string {
  if (!timestamp) return 'never';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Splits a duration into a value and its unit for the summary cards. */
export function seconds(msValue: number): string {
  if (msValue < 1000) return `${Math.round(msValue)} ms`;
  if (msValue < 60_000) return `${(msValue / 1000).toFixed(1)} s`;
  return `${(msValue / 60_000).toFixed(1)} min`;
}
