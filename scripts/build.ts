/**
 * Builds the unpacked extension into `dist/`.
 *
 * Each entry point is bundled separately as an IIFE: content scripts and the
 * Firefox MV3 event page are classic scripts, not modules, so nothing may rely
 * on `import` at runtime.
 */

import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { build as esbuild } from 'esbuild';

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
    await copyFile(join(SRC, file.from), join(DIST, file.to));
  }
  await mkdir(join(DIST, 'icons'), { recursive: true });
  for (const icon of await readdir(join(SRC, 'icons'))) {
    await copyFile(join(SRC, 'icons', icon), join(DIST, 'icons', icon));
  }
}

async function bundle(): Promise<number> {
  let bytes = 0;
  for (const entry of ENTRIES) {
    const result = await esbuild({
      entryPoints: [join(SRC, entry.from)],
      outfile: join(DIST, entry.to),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      minify,
      sourcemap: false,
      metafile: true,
      logLevel: 'error',
    }).catch(() => {
      throw new Error(`Failed to bundle ${entry.from}`);
    });
    for (const output of Object.values(result.metafile.outputs)) bytes += output.bytes;
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

/** Reads the version the manifest declares, so artefact names match the build. */
async function manifestVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(join(SRC, 'manifest.json'), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}

/**
 * Packages `dist/` for distribution.
 *
 * A Firefox add-on file is an ordinary ZIP with a different extension, so both
 * come out of one archive. The `.xpi` is what you install; the `.zip` is for
 * unpacking and loading temporarily through about:debugging.
 */
async function pack(): Promise<void> {
  const out = join(ROOT, 'web-ext-artifacts');
  await mkdir(out, { recursive: true });

  const version = await manifestVersion();
  const xpi = join(out, `tetratype-${version}.xpi`);
  const zip = join(out, `tetratype-${version}.zip`);
  await Promise.all([rm(xpi, { force: true }), rm(zip, { force: true })]);

  const code = await new Promise<number | null>((resolve) => {
    spawn('zip', ['-r', '-q', '-X', xpi, '.'], {
      cwd: DIST,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
      .on('error', () => resolve(null))
      .on('close', resolve);
  });
  if (code !== 0) throw new Error('zip failed (is the `zip` command installed?)');

  await copyFile(xpi, zip);
  const size = ((await stat(xpi)).size / 1024).toFixed(1);
  console.log(`packaged ${xpi} (${size} kB)`);
  console.log(`packaged ${zip}`);
}

await build();

if (args.has('--zip') || args.has('--xpi')) await pack();

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
