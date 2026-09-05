# Contributing

Thanks for taking a look. Tetratype is small on purpose, so contributions are easy to
review when they stay focused.

## Getting set up

```bash
bun install
bun run check   # typecheck + lint + tests + build
```

Load `dist/manifest.json` through `about:debugging#/runtime/this-firefox` to try your
changes. `bun run dev` rebuilds on save; reload the add-on from the same page to pick the
new build up.

## Before opening a pull request

Run `bun run check`. CI runs exactly that, plus `web-ext lint` against the built extension.

## What the review will look for

**Keep `src/core` pure.** No DOM, no `browser.*`, no imports from `src/content` or
`src/background`. That boundary is what makes the interesting logic testable, and it is the
one rule worth being strict about.

**Keep the Monkeytype contract in one file.** Anything that depends on the site's markup
belongs in `src/content/monkeytype.ts`, and every check should degrade to "don't know"
rather than guessing. A feature switching itself off is fine; recording wrong data is not.

**Do not widen the privacy surface.** No new permissions, no host permissions, no network
requests, and no storing of typed text beyond the n-gram labels themselves. If a feature
seems to need one of those, open an issue first — there is usually another way.

**Test the behaviour, not the implementation.** Bugs in this project tend to be about *which
keystrokes get recorded*, so a fix is most convincing with a test that types something and
asserts what came out. `test/integration.test.ts` shows the pattern.

**Write Unicode literals as escapes.** Use `'á'` rather than a decomposed character an
editor might silently renormalize. Several tests exist precisely to catch that class of bug.

## Commit messages

One line, at most seven words, [Conventional Commits](https://www.conventionalcommits.org)
style. No body, no trailers.

```
feat: track ngram latency
fix: ignore key repeat events
docs: improve installation guide
```
