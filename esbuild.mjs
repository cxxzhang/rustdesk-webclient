// Build the web client into ./dist/ (self-contained static asset tree).
//
//   npm run build            one-shot production bundle
//   npm run build:dev        unminified, with sourcemaps
//   npm run watch            rebuild on change (dev only)
//
// Two independent entry points:
//   src/ui/app.ts             -> dist/app.js               (main thread)
//   src/worker/session.worker -> dist/session.worker.js    (worker)
//
// WASM (libsodium-wrappers ships base64-inlined already; zstddec ships a .wasm)
// is inlined as base64 data URIs via the `binary` loader so the output stays a
// self-contained static asset tree with no extra fetches.

import { build, context } from 'esbuild';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(__dirname, 'dist');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  format: 'esm',
  target: ['chrome110', 'edge110'],
  platform: 'browser',
  sourcemap: true,
  minify: !dev,
  legalComments: 'linked',
  logLevel: 'info',
  loader: {
    '.wasm': 'binary',
    '.css': 'css',
  },
  alias: {
    // libsodium-wrappers' ESM build imports './libsodium.mjs' from the sibling
    // `libsodium` package — unresolvable. Bundle the CJS build instead (same
    // alias as vitest.config.ts).
    'libsodium-wrappers': require.resolve('libsodium-wrappers'),
    // jMuxer imports node's `stream` for its optional createStream() wrapper,
    // which this client never calls. Stub it rather than bundling a polyfill
    // for an unreachable path.
    stream: resolve(__dirname, 'src/shims/node-stream.ts'),
  },
  define: {
    'process.env.NODE_ENV': dev ? '"development"' : '"production"',
  },
};

const entryPoints = {
  app: resolve(__dirname, 'src/ui/app.ts'),
  'session.worker': resolve(__dirname, 'src/worker/session.worker.ts'),
  launcher: resolve(__dirname, 'src/launcher.ts'),
};

// `dist/` is the deployable tree: the shells + runtime config live in web/ and
// are copied in so a single directory can be served (or dropped on a CDN).
const SHELL_FILES = [
  'index.html',     // the client
  'launcher.html',  // sign-in + device list (product entry)
  'boot.js',        // shared __RD__/palette bootstrap
  'config.js',
  'launcher.css',
  'logo.png',
];

function copyShell() {
  for (const f of SHELL_FILES) {
    copyFileSync(resolve(__dirname, 'web', f), resolve(outdir, f));
  }
  console.log(`[esbuild] copied ${SHELL_FILES.length} shell files -> dist/`);
}

if (watch) {
  const ctx = await context({ ...shared, entryPoints, outdir });
  await ctx.watch();
  copyShell();
  console.log(`[esbuild] watching -> ${outdir}`);
} else {
  await build({ ...shared, entryPoints, outdir });
  copyShell();
  console.log(`[esbuild] built -> ${outdir}`);
}
