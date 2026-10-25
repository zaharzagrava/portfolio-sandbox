// Records which web code ran in a Chromium page (Playwright V8 coverage) and saves it as "functions of the original source files".
// Import it from a tester script or a Playwright spec:
//
//   import { startCoverage, stopCoverage } from '<repo>/scripts/aiqa/tracks/code-coverage/cover.mjs';
//   await startCoverage(page);            // before page.goto(...)
//   ... use the page ...
//   await stopCoverage(page, 'inventory'); // writes specs/.checkpoints/coverage/raw/web-inventory-<time>-<random>.json
//
// Both calls do NOTHING unless QA_COVERAGE=1 is set (or you pass { force: true }), so a spec that calls them runs the same as before in a normal run.
// Needs the page's server to still answer when stopCoverage runs (it fetches each script's source map). Chromium only (other browsers: no-op).
// One page per start/stop pair; several pages or tests are fine, every call writes its own file and `report.mjs` merges them all.
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { RAW_DIR, functionsOfScript } from './lib.mjs';

const on = (opts) => opts?.force === true || process.env.QA_COVERAGE === '1';
const started = new WeakSet();

export async function startCoverage(page, opts) {
  if (!on(opts) || !page.coverage) return false; // page.coverage exists in Chromium only
  try {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    started.add(page);
    return true;
  } catch { return false; }
}

export async function stopCoverage(page, area = 'any', opts) {
  if (!on(opts) || !started.has(page)) return null;
  started.delete(page);
  let entries;
  try { entries = await page.coverage.stopJSCoverage(); } catch { return null; }
  const functions = [];
  const maps = new Map();
  for (const e of entries) {
    if (!/^https?:\/\/[^/]+\/_next\/static\/chunks\/.+\.js(\?|$)/.test(e.url) || !e.source) continue;
    const ref = /\/\/# sourceMappingURL=(\S+)\s*$/m.exec(e.source.slice(-2000))?.[1];
    if (!ref) continue;
    const mapUrl = new URL(ref, e.url).href;
    if (!maps.has(mapUrl)) maps.set(mapUrl, await fetch(mapUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    const mapJson = maps.get(mapUrl);
    if (!mapJson) continue;
    functions.push(...functionsOfScript({ source: e.source, functions: e.functions, mapJson }));
  }
  mkdirSync(RAW_DIR, { recursive: true });
  const file = join(RAW_DIR, `web-${area}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.json`);
  writeFileSync(file, JSON.stringify({ kind: 'web-client', area, at: new Date().toISOString(), scripts: entries.length, functions }));
  return file;
}
