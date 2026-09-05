# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
