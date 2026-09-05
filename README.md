# Tetratype

**Privacy-first n-gram latency profiler for [Monkeytype](https://monkeytype.com).**

[![CI](https://github.com/donutinit/tetratype/actions/workflows/ci.yml/badge.svg)](https://github.com/donutinit/tetratype/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-e2b714.svg)](LICENSE)

A Firefox/LibreWolf extension that measures how long *your fingers* actually take to move
between keys, and tells you which letter combinations are holding your WPM back.

Monkeytype tells you that you type 96 WPM. Tetratype tells you that `br` costs you 180 ms
against a 92 ms baseline, that it shows up 340 times, and that fixing it alone is worth
about 1.4 seconds per thousand characters.

---

## Contents

- [What it measures](#what-it-measures)
- [Install](#install)
- [Reading the dashboard](#reading-the-dashboard)
- [How capture works](#how-capture-works)
- [Spanish, Unicode and dead keys](#spanish-unicode-and-dead-keys)
- [LibreWolf and timer precision](#librewolf-and-timer-precision)
- [Privacy](#privacy)
- [Storage model](#storage-model)
- [Export formats](#export-formats)
- [Feeding it to an LLM](#feeding-it-to-an-llm)
- [Development](#development)
- [Design decisions](#design-decisions)
- [Limitations](#limitations)
- [License](#license)

---

## What it measures

Every keystroke inside Monkeytype's typing input is timestamped at `keydown` — the moment
your finger actually moved, not when the character rendered. Consecutive keystrokes form a
**run**, and every run is sliced into overlapping bigrams, trigrams and tetragrams.

For the word `para` you get:

| n-gram | span | what it tells you |
| ------ | ---- | ----------------- |
| `pa` `ar` `ra` | one transition each | raw finger-to-finger speed |
| `par` `ara` | two transitions | whether the pair chains smoothly |
| `para` | three transitions | the whole motion as one unit |

Trigrams and tetragrams also keep their **internal transitions**, so you can open `para` in
the dashboard and see that `p→a` takes 95 ms, `a→r` takes 210 ms and `r→a` takes 88 ms —
the tetragram is slow because of exactly one bad jump in the middle.

Per n-gram, Tetratype tracks:

| Metric | Meaning |
| ------ | ------- |
| **Samples** | How many times the n-gram was observed. |
| **Median** | Middle total duration over the recent window. Robust to the occasional stall. |
| **Mean** | Lifetime average, computed from stored moments over every observation ever. |
| **p90** | 90th percentile. The slow tail you hit on a bad rep. |
| **Best / Worst** | Fastest and slowest observations ever recorded. |
| **ms/step** | Median divided by the number of transitions, so n-grams of different lengths are comparable. |
| **Var** | Coefficient of variation (σ/μ). High means erratic — you *can* type it fast, but you don't reliably. |
| **Impact** | Time lost to this n-gram, scaled 0–100 against the worst of its length. |

### The impact score

Being slow at a rare combination barely matters. Being slightly slow at a very common one
matters a lot. Impact combines both:

```
baseline        = 20th percentile of your own bigram speeds, weighted by frequency
expected        = baseline × (n - 1)
excess          = max(0, median - expected)      # ms lost per occurrence
ms lost         = excess × samples               # ms lost in total, so far
impact          = ms lost, rescaled 0–100 within each n-gram length
```

The baseline is *yours*, not an average typist's: it answers "how fast do I move between
keys when nothing is in the way", and every n-gram is judged against that. Impact is
normalized separately for bigrams, trigrams and tetragrams so that inherently slower
tetragrams do not crowd bigrams out of the ranking.

Two headline numbers sit on top of the dashboard:

- **Implied WPM** — the speed your measured bigram timings add up to.
- **Ceiling WPM** — the speed you would reach if *every* bigram ran at your own baseline.

The gap between them is the size of the prize.

---

## Install

Tetratype is not on Mozilla Add-ons yet. Install it temporarily — the extension stays
loaded until you close the browser.

**Requirements:** Firefox or LibreWolf 115+.

Either download `tetratype.zip` from the
[latest release](https://github.com/donutinit/tetratype/releases/latest) and unzip it, or
build it yourself with [Bun](https://bun.sh):

```bash
git clone https://github.com/donutinit/tetratype.git
cd tetratype
bun install
bun run build
```

Then, in Firefox or LibreWolf:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select the **`manifest.json`** inside the unzipped folder (or in `dist/` if you built it).
4. Open <https://monkeytype.com> and type.
5. Click the Tetratype toolbar icon, then **Open dashboard**.

Data appears within a few seconds of typing. The dashboard is also reachable from
`about:addons` → Tetratype → **Preferences**.

> **Temporary add-ons are removed when the browser restarts.** Your captured data is *not* —
> it stays in extension storage and reappears when you load the extension again. To be safe
> before a browser update, use **Export JSON**.

### Keeping it installed permanently

Temporary loading is the intended flow for now. If you want it to survive restarts, you can
build a signed XPI through [Mozilla's self-distribution flow](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/),
or run [Firefox Developer Edition](https://www.mozilla.org/firefox/developer/) with
`xpinstall.signatures.required` set to `false` in `about:config`.

---

## Reading the dashboard

- **Tabs** switch between bigrams, trigrams and tetragrams.
- **Click any column header** to sort; click again to reverse.
- **Click a row** to expand it and see the internal transitions, with a bar showing where
  the time actually goes.
- **Contains** filters by substring, so `ñ` or `qu` narrows the table instantly.
- **Min samples** hides n-grams you have not typed often enough to trust.
- The three panels at the top surface the worst offenders by speed, by consistency and by
  impact, following whichever tab you have selected.

Everything except the n-gram cap and sample window takes effect immediately; those two
apply to newly recorded data.

---

## How capture works

The quality of this data depends entirely on refusing to record anything ambiguous. A run
of keystrokes ends — and never produces an n-gram spanning the break — when any of these
happens:

| Event | Why it breaks the run |
| ----- | --------------------- |
| **Space** | N-grams stay inside a single word. Turn on *Include spaces* to treat them as ordinary characters. |
| **Backspace** | The deleted characters are dropped and the clean prefix is kept: `parx` ⌫ commits `pa`, `ar`, `par` and discards anything touching `x`. |
| **A wrong letter** | When Monkeytype flags a character, that keystroke and the hesitation around it are removed. |
| **A pause** | A gap longer than the pause threshold (1000 ms by default) is thinking, not typing. |
| **Losing focus** | Tab switches, window blur and page hide all end the run. |
| **Paste, drop, autofill, undo** | Text that no keypress produced is never timed. |
| **Key repeat** | Holding a key down produces intervals that mean nothing. |
| **Word-level deletion** | `Ctrl`+`Backspace` removes an unknown amount, so the whole run is discarded. |

Timestamps come from `keydown`, and a character is only recorded when a matching
`beforeinput` confirms what it produced within 150 ms. That pairing is what makes dead keys
and IME composition come out right.

---

## Spanish, Unicode and dead keys

Tetratype is built to be used with a Spanish layout, and `ñ`, `á`, `¿` and friends are
first-class characters rather than edge cases.

- **Everything is NFC-normalized.** A dead key that produces `a` + U+0301 and a precomposed
  `á` land in the same bucket instead of splitting your data in two.
- **A lone combining mark is folded into the letter it modifies.** Layouts that deliver the
  accent as its own input event still produce one character, not two.
- **Composition is handled at `compositionend`**, so an IME contributes one character with
  one timestamp rather than a stream of intermediate states.
- **N-grams are split on grapheme boundaries** (via `Intl.Segmenter`, with a fallback), so
  the transitions of `año` are `a→ñ` and `ñ→o` — never a stray combining mark on its own.
- **Dead-key time is charged to the accented character.** Typing `á` means pressing two
  keys, so the transition *into* `á` includes both. That is the honest cost of the letter.

---

## LibreWolf and timer precision

This matters, and Tetratype will tell you about it in a banner if it applies to you.

Firefox rounds `event.timeStamp` to defend against fingerprinting. At the default 1 ms this
is harmless. **LibreWolf enables `privacy.resistFingerprinting` by default**, which can
round timers to 100 ms — and at that granularity every inter-key interval collapses onto a
handful of values and the entire profile becomes meaningless.

Tetratype measures the real granularity of the page clock and warns you when it exceeds
5 ms. To fix it, in `about:config`:

```
privacy.resistFingerprinting.reduceTimerPrecision.microseconds = 1000
```

That gives 1 ms resolution — plenty for keystroke timing — while leaving the rest of
`resistFingerprinting` intact. Reload Monkeytype afterwards.

---

## Privacy

Tetratype is designed so that there is nothing to leak.

- **It only exists on Monkeytype.** The content script is declared for
  `https://monkeytype.com/*` and `https://www.monkeytype.com/*`. There is no
  `<all_urls>`, and no host permissions at all.
- **The only permission requested is `storage`.** Not `tabs`, not `activeTab`, not
  `webRequest`. Settings reach the content script through `storage.onChanged` specifically
  so that no extra permission is needed.
- **It never makes a network request.** No telemetry, no analytics, no crash reporting, no
  remote configuration, no CDN. The extension has no code that can reach the network.
- **Your keystrokes are never written to disk.** Nothing stores the text you typed. What is
  persisted per n-gram is a count, four running sums, a min, a max, and a bounded ring of
  recent durations. The n-gram *label* — `pa`, `año` — is the only text kept, and only for
  combinations you typed at least once.
- **Only the typing input is read.** The capture layer accepts events from Monkeytype's
  words input, or from an input inside the typing-test container. Every other field on the
  site — the login form, the password box, the search bar — fails that check and is never
  observed. This is enforced in [`src/content/monkeytype.ts`](src/content/monkeytype.ts) and
  covered by [tests](test/monkeytype.test.ts).
- **It never interferes with the page.** All listeners are passive and nothing calls
  `preventDefault`. Tetratype cannot change how Monkeytype behaves.
- **Everything is local and yours.** Data lives in `storage.local` in your browser. Export
  it, import it, or wipe it from the dashboard.

The manifest declares `data_collection_permissions: { required: ["none"] }`, Mozilla's
formal statement that an extension collects nothing.

---

## Storage model

Storing every keystroke forever would grow without bound and would be exactly the kind of
data this project does not want to hold. Instead each n-gram keeps a fixed-size record:

```ts
{
  gram: 'para',            // the characters
  count: 412,              // lifetime observations
  sum, sumSq,              // moments → exact mean and variance in O(1) space
  min, max,                // lifetime extremes
  tSum[], tSumSq[],        // the same, per internal transition
  recent: [...],           // ring buffer of the last N durations
  cursor, updated,
}
```

Two ideas do the work:

- **Moments, not samples.** Mean, standard deviation and coefficient of variation come from
  running sums, so they are exact over your entire history at constant cost.
- **A recency window for quantiles.** Median and p90 come from a ring buffer of the most
  recent durations (40 by default). This is deliberately *not* your lifetime distribution:
  it reflects how you type now, not how you typed six months ago.

Durations are rounded to 0.1 ms — finer than any keyboard, and much smaller as JSON. When
the number of distinct n-grams exceeds the cap (12 000 by default), the least-used and
least-recent are pruned first. Writes are debounced so a typing session produces a store
write every few seconds, not one per keystroke. The dashboard shows the current size.

Both the window and the cap are adjustable in Settings.

---

## Export formats

**JSON** — the full profile plus your settings, suitable for backup or moving between
machines. Importing offers *merge* (moments are summed, sample windows interleaved) or
*replace*. Exports are versioned and validated on import; malformed records are dropped
rather than corrupting your profile.

```json
{
  "format": "tetratype-profile",
  "version": 1,
  "exportedAt": 1757000000000,
  "settings": { "...": "..." },
  "store": { "grams": { "4:para": { "gram": "para", "count": 412, "...": "..." } } }
}
```

**CSV** — one row per n-gram, for spreadsheets and ad-hoc analysis:

```
n,ngram,samples,median_ms,mean_ms,p90_ms,min_ms,max_ms,sd_ms,cv,
ms_per_transition,excess_ms,ms_lost,impact,transitions,last_seen
```

The `transitions` column packs the internal breakdown into one field:
`p>a:95.10|a>r:210.40|r>a:88.20`.

---

## Feeding it to an LLM

The CSV export is designed to be handed to a language model, which can read the transition
breakdowns and turn them into a diagnosis and a practice wordlist you can paste straight
back into Monkeytype.

**Export it first:** in the dashboard, set **Min samples** to `20` or higher, then click
**Export CSV**. That box is the only filter the export honours — the tab and the *Contains*
field do not narrow it, so you always get bigrams, trigrams and tetragrams in one file.
Raising the threshold matters: an unfiltered profile can run to thousands of rows, most of
them too thin to mean anything, and it will crowd out the model's context for no benefit.

Then paste the prompt below, replace the language, and paste the CSV underneath it.

```text
You are analysing a Tetratype export: per-n-gram keystroke latency measured from my own
typing on Monkeytype. Tell me what to practise, and build me a practice wordlist.

## The data

CSV, one row per n-gram:

  n                  n-gram length (2 = bigram, 3 = trigram, 4 = tetragram)
  ngram              the literal characters
  samples            how many times I typed it
  median_ms          median total duration, over a window of recent observations
  mean_ms            lifetime mean
  p90_ms             90th percentile - my bad reps
  min_ms / max_ms    fastest and slowest ever recorded
  sd_ms              standard deviation
  cv                 sd / mean. Low = reliable, high = erratic
  ms_per_transition  median / (n - 1), so lengths are comparable
  excess_ms          how much slower than my own baseline, per occurrence
  ms_lost            excess_ms x samples: total time this has cost me
  impact             ms_lost rescaled 0-100 within each n
  transitions        per-jump means, e.g. p>a:95.10|a>r:210.40|r>a:88.20
  last_seen          ISO timestamp of the most recent observation

Timings run keydown to keydown, so a value is the time to move between the keys of the
n-gram, never the time to press the first one. The baseline behind excess_ms is the 20th
percentile of my own bigram speeds, so everything is measured against me, not a norm.

## How to read it

- Ignore rows with few samples. They are noise however bad they look.
- Rank by impact and ms_lost, not by median. Something I type constantly and am slightly
  slow at costs me more than something I am dreadful at but type once a week.
- Separate two different problems:
    - High excess_ms, low cv -> a real motor weakness. Worth drilling.
    - High cv with a good min_ms -> I can already do it fast, just not reliably. Usually
      rhythm, or an awkward transition I sometimes fumble rather than one I cannot make.
- Use the transitions column. This is the point of the export. A slow tetragram is
  normally one bad jump, not four mediocre ones - say which jump, and check whether that
  same pair is also slow in its own bigram row.
- Cross-check context. If a bigram is fast alone but slow inside the longer n-grams that
  contain it, the pair is fine and the problem is what surrounds it. Say so.
- Never state a number that is not in the data, and never guess at my layout, my fingers
  or my hardware. Work from the rows.

## What to give me

1. Diagnosis, at most 10 lines. What is actually holding me back, grouped by cause
   (same-finger jumps, awkward rolls, a weak finger, accented characters - whatever the
   data shows). Cite the rows you read it from.

2. A table of 10-15 n-grams worth practising, most valuable first. For each: samples,
   ms_per_transition, cv, impact, which internal jump is the problem, and one line on why
   it earned its place.

3. A practice wordlist for Monkeytype:
   - Real words in LANGUAGE. No invented words, no nonsense syllables.
   - Every n-gram from the table appears at least four times across the list.
   - Weight by impact: the worst offenders should recur most often.
   - 150-200 words, lowercase, single spaces, one continuous block, no punctuation and no
     line breaks, so I can paste it into Monkeytype custom text unchanged.
   - Keep accents and n-tilde exactly as the words require. Do not strip them.
   - Vary word length, and do not park every target n-gram at the start of a word.
   - Put the wordlist in its own code block, with nothing else inside it.

4. A short paragraph on what to pay attention to while drilling, and what would count as
   improvement in a re-export.
```

Replace `LANGUAGE` with the language you actually type in — `Spanish`, `English`, or both if
you switch between them. Ask for the accented characters to be kept; a model told only
"Spanish" will sometimes strip them, and `ñ` and `á` are exactly the keys worth measuring.

Re-export after a week of practice and give the model both files to compare. `min_ms` moving
before `median_ms` is the normal shape of progress: the motion becomes available to you
before it becomes reliable.

The JSON export is for backup and merging profiles, not for analysis — it carries the raw
ring buffers and is far larger with nothing extra a model can use.

---

## Development

```bash
bun install
bun run dev        # rebuild dist/ on change
bun test           # 174 tests
bun run typecheck  # tsc --noEmit
bun run lint       # biome
bun run format     # biome --write
bun run build      # unpacked extension into dist/
bun run build:zip  # plus a zip in web-ext-artifacts/
bun run check      # everything CI runs
```

### Layout

```
src/
  core/        pure logic — no DOM, no browser APIs, fully unit tested
    run.ts         keystrokes → clean runs (the sequence-breaking rules)
    ngram.ts       runs → n-gram observations
    store.ts       bounded aggregation, pruning, merging
    stats.ts       quantiles, baseline, impact scoring
    text.ts        NFC normalization and grapheme splitting
    timing.ts      clock resolution probe
    serialize.ts   JSON import/export and CSV
  content/     the only code that touches Monkeytype
    monkeytype.ts  the entire DOM contract with the site, isolated
    capture.ts     DOM events → run events
  background/  the single writer of the profile
  dashboard/   the UI
  popup/       toolbar popup
```

`src/core` has no imports from `src/content`, `src/background` or the browser, which is
what makes the interesting logic testable without a DOM. `Capture` takes structural event
types rather than real DOM events for the same reason.

---

## Design decisions

**Manifest V3 with an event page.** Firefox supports `background.scripts` under MV3;
Chrome's service-worker model is not used because this extension is Firefox-only. MV3 also
makes the permission story cleaner.

**A background page as the single writer.** Two Monkeytype tabs would otherwise interleave
read-modify-write cycles against the same store. Content scripts only ever send finished
observations; all merging happens in one place.

**Spaces break runs by default.** Cross-word transitions are dominated by where the next
word starts, not by finger movement. Keeping n-grams inside a word makes them comparable.
The setting is there if you disagree.

**A recency window rather than a reservoir sample.** A reservoir gives you a lifetime
distribution. For training feedback, "how fast am I at this *now*" is the more useful
question, and a ring buffer answers it exactly rather than approximately.

**Timestamps from `keydown`, characters from `beforeinput`.** `keydown` is when the motion
happened; `beforeinput` is what actually got produced, after dead keys and composition. Each
event answers the question it is good at.

**The DOM contract is one small file.** Monkeytype can change its markup at any time.
Everything that depends on it lives in `src/content/monkeytype.ts`, and each check degrades
to "don't know" — which disables a feature rather than recording wrong data.

---

## Limitations

- **Monkeytype's markup can change.** If the typing input or the error classes are renamed,
  capture may stop or error detection may quietly switch off. The dashboard's *Last capture*
  card is the quickest way to notice. Fixes belong in `src/content/monkeytype.ts`.
- **The first character of a run has no interval**, so it is never scored on its own. This
  is inherent: there is nothing to measure it against.
- **Coarse timers make the data meaningless**, which is why the warning exists. See
  [LibreWolf and timer precision](#librewolf-and-timer-precision).
- **N-grams are case-sensitive.** `Pa` and `pa` are different motions, because one of them
  involves Shift.
- **Error detection lags by one keystroke**, since Monkeytype updates its markup after
  handling the input. The mistyped character is still removed correctly.
- **Not published on Mozilla Add-ons.** Temporary installation only, for now.

---

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
