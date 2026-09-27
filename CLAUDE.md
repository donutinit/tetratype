# tetratype

Extensión de Firefox/LibreWolf que perfila la latencia por n-gramas al escribir en
Monkeytype, sin mandar nada a ningún lado. Repo público. Uso y arquitectura en `README.md`;
flujo de contribución en `CONTRIBUTING.md`. `CLAUDE.md` es un hard link de este archivo.

## Comandos

```sh
npm ci
npm run check      # typecheck + lint (biome) + tests (vitest) + build: lo mismo que CI
npm run dev        # reconstruye dist/ al guardar
npm run build:xpi  # .xpi y .zip en web-ext-artifacts/
npx --no-install web-ext lint --source-dir dist --self-hosted
```

## Reglas

- **`src/core` es puro:** nada de DOM, `browser.*` ni imports de `src/content` o
  `src/background`. Es la regla que hace testeable la lógica.
- Privacidad primero: nada de red ni telemetría. Todo se queda en el almacenamiento local de la
  extensión.
- Tests con vitest (`test/*.test.ts`, DOM con happy-dom). No uses matchers exclusivos de bun.
- El build es `scripts/build.ts` con esbuild, corrido directo por Node (≥ 22.18). Cada entrada
  es un IIFE: content scripts y la event page de MV3 no pueden depender de `import` en runtime.
- vitest se queda en 3.2.x: la 4 y la 5 no resuelven con el npm 10.9 del sistema.
- npm estricto (política en `~/.claude/CLAUDE.md`). Commits en inglés, minúsculas, cortos.
  Sin trailers de atribución. `CHANGELOG.md` se actualiza en `[Unreleased]`.
