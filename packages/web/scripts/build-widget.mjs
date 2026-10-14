// Builds the widget checkout application (W07 AS-39): one self-contained script, no `eval`, served by
// app/widget/v1/app.js/route.ts from `.widget/app.js`.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, '.widget/app.js');
mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(root, 'lib/widget/app-entry.tsx')],
  outfile,
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  platform: 'browser',
  jsx: 'automatic',
  tsconfig: resolve(root, 'tsconfig.json'),
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  logLevel: 'warning',
});

console.log(`widget bundle written to ${outfile}`);
