# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Releases now carry an installable `tetratype-<version>.xpi` alongside the zip, built
  automatically by CI. `bun run build:xpi` does the same locally.
- Optional Mozilla signing for self-distribution, on the `unlisted` channel, gated on the
  `AMO_API_KEY` and `AMO_API_SECRET` repository secrets. Without them the release is
  unchanged.

### Changed

- `build:zip` is now `build:xpi`, and artefacts are named with the manifest version.

## [0.2.0] — 2026-09-05

Mistakes, hands, and time.

### Added

- **Keyboard layout modelling.** Every transition is classified as same-finger, scissor,
  inward or outward roll, alternating, redirect, double tap or dead key, from the layout you
  select — QWERTY (Spanish, the default), QWERTY (US), Colemak or Dvorak. Shown per n-gram
  and per internal jump.
- **Mistake tracking.** Reads the character the test is waiting for during `beforeinput`,
  so a typo is named rather than merely counted: an `expected → typed` confusion table with
  counts, physical relation, and how the mistake was resolved.
- **Recovery cost.** Milliseconds from a slip to the right character landing, counted only
  once the cursor has actually rewound over the mistake. Mistakes typed straight past are
  counted separately as left standing.
- **Error rate per character and per transition**, joined onto the n-gram table as a miss
  rate, plus a most-error-prone highlight panel.
- **Speed against accuracy curve**, naming the fastest interval band where accuracy holds.
- **Within-session curve** for warm-up and fatigue, with sessions split after five idle
  minutes.
- **Daily history** of WPM and accuracy over the last 180 days.
- **Per-n-gram trend**, from a fast and a slow exponentially weighted mean.
- **Context penalty**: how much more a pair costs inside longer n-grams than on its own.
- **Analysis export**: one Markdown file with every table and curve, built to hand to a
  language model. The README carries a prompt written against it.
- Settings for keyboard layout and for turning mistake tracking off.

### Changed

- A detected mistake now breaks the run immediately instead of a keystroke later, so the
  clean prefix is kept and the wrong keystroke never enters a timing.
- The CSV export gained `shape`, `same_finger`, `row_jump`, `dead_keys`, `miss_rate`,
  `miss_attempts`, `trend_ms` and `context_ms`.
- Store schema is version 2. Version 1 profiles import unchanged; the new fields start empty.

[0.2.0]: https://github.com/donutinit/tetratype/releases/tag/v0.2.0

## [0.1.0] — 2026-09-05

First release.

### Added

- Keystroke capture on `monkeytype.com`, scoped to the typing input only.
- Bigram, trigram and tetragram latency tracking, with internal transition breakdowns for
  trigrams and tetragrams.
- Per-n-gram statistics: sample count, median, mean, p90, best, worst, ms per transition,
  coefficient of variation, and an impact score derived from your own baseline speed.
- Implied and ceiling WPM derived from measured bigram timings.
- Sequence breaking on spaces, corrections, detected errors, long pauses, focus loss, key
  repeat and non-typed input, so no n-gram spans an interruption.
- Unicode handling for Spanish and beyond: NFC normalization, grapheme-boundary splitting,
  dead keys and IME composition.
- Dashboard with filtering, sorting, expandable transition views and live updates.
- Toolbar popup with capture state and headline numbers.
- Pause and resume capture, reset, JSON export and import (merge or replace), CSV export.
- Bounded storage: constant-space moments per n-gram plus a recency window for quantiles,
  with pruning past a configurable cap.
- Clock resolution probe that warns when anti-fingerprinting rounding makes timings
  meaningless, with the `about:config` fix.

[0.1.0]: https://github.com/donutinit/tetratype/releases/tag/v0.1.0
