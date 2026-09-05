/**
 * The analysis bundle.
 *
 * One Markdown file holding everything a reader — human or model — needs to
 * diagnose your typing: the headline numbers, the n-gram table, the mistakes,
 * and the curves. It exists so the workflow is "export, paste" rather than
 * "export, find the right file, explain the columns, paste".
 */

import {
  accuracyCliff,
  charAccuracy,
  confusionRanking,
  dailyHistory,
  fatigueCurve,
  speedAccuracyCurve,
  summarizeAccuracy,
} from './insights';
import { getLayout } from './layout';
import { confusionsToCsv, toCsv } from './serialize';
import type { Settings } from './settings';
import type { NgramStats, ProfileSummary } from './stats';
import type { ProfileStore } from './types';

export interface ReportInput {
  store: ProfileStore;
  settings: Settings;
  stats: readonly NgramStats[];
  summary: ProfileSummary;
  /** N-grams below this are left out, to keep the bundle worth reading. */
  minSamples: number;
  now?: number;
}

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function ms(value: number, digits = 0): string {
  return value.toFixed(digits);
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}\n`;
}

/** Builds the whole bundle as Markdown. */
export function buildReport(input: ReportInput): string {
  const { store, settings, summary, minSamples } = input;
  const now = input.now ?? Date.now();
  const accuracy = summarizeAccuracy(store.metrics);
  const rows = input.stats.filter((s) => s.count >= minSamples);
  const layout = getLayout(settings.layout);

  const header = [
    '# Tetratype analysis',
    '',
    `Exported ${new Date(now).toISOString()} · layout ${layout.name} · ` +
      `n-grams with at least ${minSamples} samples.`,
    '',
    'Timings run keydown to keydown, so a value is the time to move between the keys of an',
    'n-gram, never the time to press the first one. `excess_ms` is measured against this',
    "typist's own baseline: the 20th percentile of their bigram speeds.",
    '',
  ].join('\n');

  const overview = [
    `- Implied WPM: **${summary.impliedWpm.toFixed(1)}**, ceiling at own baseline: **${summary.ceilingWpm.toFixed(1)}**`,
    `- Baseline: ${ms(summary.baseline.transitionMs, 1)} ms per transition` +
      `${summary.baseline.reliable ? '' : ' (provisional — not much data yet)'}`,
    `- Keystrokes: ${summary.keystrokes}, clean runs: ${summary.runs}, observations: ${summary.samples}`,
    `- N-grams tracked: ${summary.uniqueGrams[2]} bigrams, ${summary.uniqueGrams[3]} trigrams, ${summary.uniqueGrams[4]} tetragrams`,
    `- Accuracy: ${accuracy.attempts > 0 ? pct(accuracy.accuracy) : 'not tracked'}` +
      ` (${accuracy.errors} slips in ${accuracy.attempts})`,
    `- Time lost to slow bigrams: ${(summary.totalMsLost / 1000).toFixed(1)} s;` +
      ` to fixing typos: ${(accuracy.msLostToErrors / 1000).toFixed(1)} s`,
    `- Mistakes left standing: ${accuracy.uncorrected}; mean recovery ${ms(accuracy.meanRecoveryMs)} ms`,
    `- Sessions recorded: ${accuracy.sessions}`,
  ].join('\n');

  const curve = speedAccuracyCurve(store.metrics);
  const cliff = accuracyCliff(curve);
  const speedLines =
    curve.length === 0
      ? '_Not enough keystrokes yet._'
      : [
          '| interval band (ms) | keystrokes | errors | error rate |',
          '| --- | --- | --- | --- |',
          ...curve.map(
            (p) => `| ${p.fromMs}–${p.toMs} | ${p.attempts} | ${p.errors} | ${pct(p.rate)} |`,
          ),
          '',
          cliff
            ? `Accuracy holds down to **${cliff.fromMs}–${cliff.toMs} ms** between keys.`
            : 'Error rate is above 5% in every band measured.',
        ].join('\n');

  const fatigue = fatigueCurve(store.metrics);
  const fatigueLines =
    fatigue.length === 0
      ? '_Not enough long sessions yet._'
      : [
          '| keystrokes into session | mean ms/key | error rate |',
          '| --- | --- | --- |',
          ...fatigue.map(
            (p) =>
              `| ${p.fromKeystrokes}–${p.toKeystrokes} | ${ms(p.meanMs, 1)} | ${pct(p.rate)} |`,
          ),
        ].join('\n');

  const history = dailyHistory(store.metrics);
  const historyLines =
    history.length === 0
      ? '_Not enough days yet._'
      : [
          '| date | keystrokes | wpm | accuracy |',
          '| --- | --- | --- | --- |',
          ...history.map(
            (d) => `| ${d.date} | ${d.attempts} | ${d.wpm.toFixed(1)} | ${pct(1 - d.rate)} |`,
          ),
        ].join('\n');

  const chars = charAccuracy(store.metrics, Math.max(10, minSamples * 2)).slice(0, 20);
  const charLines =
    chars.length === 0
      ? '_Not enough data yet._'
      : [
          '| character | attempts | errors | error rate |',
          '| --- | --- | --- | --- |',
          ...chars.map((c) => `| \`${c.char}\` | ${c.attempts} | ${c.errors} | ${pct(c.rate)} |`),
        ].join('\n');

  const confusions = confusionRanking(store.metrics, { layout: settings.layout });

  return [
    header,
    section('Overview', overview),
    section(
      'N-grams',
      `Bigrams, trigrams and tetragrams together.\n\n\`\`\`csv\n${toCsv(rows)}\`\`\``,
    ),
    section(
      'Mistakes',
      confusions.length === 0
        ? '_No repeated mistakes recorded._'
        : `\`\`\`csv\n${confusionsToCsv(confusions)}\`\`\``,
    ),
    section('Characters most often missed', charLines),
    section('Speed against accuracy', speedLines),
    section('Within a session', fatigueLines),
    section('Day by day', historyLines),
  ].join('\n');
}
