/**
 * Builds the unpacked extension into `dist/`.
 *
 * Each entry point is bundled separately as an IIFE: content scripts and the
 * Firefox MV3 event page are classic scripts, not modules, so nothing may rely
 * on `import` at runtime.
 */

import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

const ENTRIES = [
  { from: 'content/index.ts', to: 'content.js' },
  { from: 'background/index.ts', to: 'background.js' },
  { from: 'dashboard/main.ts', to: 'dashboard.js' },
  { from: 'popup/main.ts', to: 'popup.js' },
];

const STATIC_FILES = [
  { from: 'manifest.json', to: 'manifest.json' },
  { from: 'dashboard/index.html', to: 'dashboard.html' },
  { from: 'dashboard/style.css', to: 'dashboard.css' },
  { from: 'popup/index.html', to: 'popup.html' },
  { from: 'popup/style.css', to: 'popup.css' },
];

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const minify = !args.has('--no-minify');

async function copyStatic(): Promise<void> {
  for (const file of STATIC_FILES) {
    await Bun.write(join(DIST, file.to), Bun.file(join(SRC, file.from)));
  }
  await mkdir(join(DIST, 'icons'), { recursive: true });
  for (const icon of await readdir(join(SRC, 'icons'))) {
    await Bun.write(join(DIST, 'icons', icon), Bun.file(join(SRC, 'icons', icon)));
  }
}

async function bundle(): Promise<number> {
  let bytes = 0;
  for (const entry of ENTRIES) {
    const result = await Bun.build({
      entrypoints: [join(SRC, entry.from)],
      outdir: DIST,
      target: 'browser',
      format: 'iife',
      minify,
      sourcemap: 'none',
      naming: { entry: entry.to },
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error(`Failed to bundle ${entry.from}`);
    }
    for (const artifact of result.outputs) bytes += artifact.size;
  }
  return bytes;
}

async function build(): Promise<void> {
  const started = Date.now();
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  const bytes = await bundle();
  await copyStatic();
  const kb = (bytes / 1024).toFixed(1);
  console.log(`built dist/ — ${kb} kB of JS in ${Date.now() - started} ms`);
}

async function zip(): Promise<void> {
  const out = join(ROOT, 'web-ext-artifacts');
  await mkdir(out, { recursive: true });
  const target = join(out, 'tetratype.zip');
  await rm(target, { force: true });
  const proc = Bun.spawn(['zip', '-r', '-q', target, '.'], {
    cwd: DIST,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if ((await proc.exited) !== 0) throw new Error('zip failed (is the `zip` command installed?)');
  console.log(`packaged ${target}`);
}

await build();

if (args.has('--zip')) await zip();

if (watch) {
  const { watch: fsWatch } = await import('node:fs');
  console.log('watching src/ …');
  let queued: ReturnType<typeof setTimeout> | null = null;
  fsWatch(SRC, { recursive: true }, (_event, file) => {
    if (file && basename(file).startsWith('.')) return;
    if (queued) clearTimeout(queued);
    queued = setTimeout(() => {
      build().catch((error: unknown) => console.error(error));
    }, 80);
  });
}
