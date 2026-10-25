#!/usr/bin/env node
// Runs the permanent Playwright specs (packages/web/tests/seller/**/*.spec.ts) that cover map lines needing a check, and marks the lines from the results.
// node scripts/aiqa/run-specs.mjs <area> [--all] [--dry] [--no-recheck]
//   default: first recheck.mjs logic (changed lines go back to untested), then only specs that annotate an untested line of the area run.
//   --all: every spec that annotates a line of the area runs, whatever the status.   --dry: only print what would run.
// A spec names its lines with the annotation { type: 'aiqa-lines', description: 'orders.page.heading,orders.page.session-guard' } on the test.
// Result per line: every test annotated with it passed -> mark pass (the fingerprint is stored by mark.mjs); one failed -> mark bug (bugs "spec-fail");
// only skipped tests -> the line is left as it is. A passing line with an unchanged fingerprint is never run and never re-examined.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AIQA, REPO, areas, diffFp, editLine, fingerprintOf, loadMap, readFps, today, withLock, COVERAGE } from './lib.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const area = args.find((a) => !a.startsWith('--'));
if (!area || !areas().includes(area)) { console.error('usage: run-specs.mjs <area> [--all] [--dry] [--no-recheck]'); process.exit(2); }
const dry = flags.has('--dry'), all = flags.has('--all');
const WEB = join(REPO, 'packages', 'web');
const SPEC_DIR = join(WEB, 'tests', 'seller');
const specFiles = (dir, rel = '') => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? specFiles(join(dir, e.name), `${rel}${e.name}/`) : e.name.endsWith('.spec.ts') ? [`${rel}${e.name}`] : []) : [];

// 1. which lines does each spec file cover (static read of the annotations)
const coverage = new Map(); // file -> Set(lineId)
if (existsSync(SPEC_DIR)) {
  for (const f of specFiles(SPEC_DIR)) {
    const text = readFileSync(join(SPEC_DIR, f), 'utf8');
    const ids = new Set();
    for (const m of text.matchAll(/type:\s*['"]aiqa-lines['"]\s*,\s*description:\s*(['"`])([\s\S]*?)\1/g)) m[2].split(/[\s,]+/).filter((i) => i.startsWith(`${area}.`)).forEach((i) => ids.add(i));
    // specs that annotate through a helper (lines('id', ...)) or in a table of ids: any known line id of the area written in the file counts
    const knownIds = new Set(loadMap(area).map((r) => r.id));
    for (const m of text.matchAll(/[a-z][a-z0-9-]*(?:\.[a-z0-9-]+){2,}/g)) if (knownIds.has(m[0])) ids.add(m[0]);
    if (ids.size) coverage.set(`tests/seller/${f}`, ids);
  }
}
if (!coverage.size) { console.log('no spec in packages/web/tests/seller annotates lines of this area yet (annotation type "aiqa-lines")'); process.exit(0); }

// 2. stale lines go back to untested (same logic as recheck.mjs)
const rows = loadMap(area), stored = readFps(area);
const stale = rows.filter((r) => ['pass', 'bug'].includes(r.status) && stored[r.id] && diffFp(stored[r.id], fingerprintOf(r).fp).length);
if (stale.length) {
  console.log(`${stale.length} checked line(s) changed since their check${flags.has('--no-recheck') || dry ? '' : ': set back to untested'}`);
  if (!flags.has('--no-recheck') && !dry) execFileSync('node', [join(AIQA, 'recheck.mjs'), area], { stdio: 'inherit' });
}
const staleIds = new Set(stale.map((r) => r.id));
const known = new Set(rows.map((r) => r.id));
for (const [f, ids] of coverage) for (const id of ids) if (!known.has(id)) console.log(`warning: ${f} annotates unknown line "${id}"`);

// 3. choose specs
const need = new Set(loadMap(area).filter((r) => r.status === 'untested' || r.status === 'blocked' || staleIds.has(r.id)).map((r) => r.id));
const chosen = [...coverage].filter(([, ids]) => [...ids].some((id) => known.has(id) && (all || need.has(id)))).map(([f]) => f);
const skippedSpecs = coverage.size - chosen.length;
console.log(`${chosen.length} spec file(s) to run, ${skippedSpecs} left out (all their lines are checked and unchanged)`);
for (const f of chosen) console.log(`  ${f}  (${[...coverage.get(f)].filter((i) => known.has(i)).length} lines)`);
if (dry || !chosen.length) process.exit(0);

// 4. run
const out = join(COVERAGE, `.run-specs-${area}.json`);
rmSync(out, { force: true });
const run = spawnSync('npx', ['playwright', 'test', ...chosen, '--reporter=json'], { cwd: WEB, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: out }, stdio: ['ignore', 'ignore', 'inherit'] });
if (!existsSync(out)) { console.error(`Playwright produced no report (exit ${run.status})`); process.exit(1); }
const report = JSON.parse(readFileSync(out, 'utf8'));
rmSync(out, { force: true });

// 5. results per line
const results = new Map(); // lineId -> { passed, failed, skipped, why }
const walk = (suite) => {
  for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
    const ids = (test.annotations ?? []).filter((a) => a.type === 'aiqa-lines').flatMap((a) => (a.description ?? '').split(/[\s,]+/).filter(Boolean));
    const status = test.status; // expected | unexpected | flaky | skipped
    const err = test.results?.at(-1)?.error?.message?.split('\n')[0] ?? '';
    for (const id of ids) {
      const r = results.get(id) ?? { passed: 0, failed: 0, skipped: 0, why: '' };
      if (status === 'expected') r.passed++; else if (status === 'skipped') r.skipped++; else { r.failed++; r.why ||= `${spec.title} [${test.projectName}] ${status}: ${err}`.slice(0, 160); }
      results.set(id, r);
    }
  }
  (suite.suites ?? []).forEach(walk);
};
(report.suites ?? []).forEach(walk);

let pass = 0, bug = 0, left = 0;
for (const [id, r] of results) {
  if (!known.has(id)) continue;
  if (r.failed) {
    execFileSync('node', [join(AIQA, 'mark.mjs'), area, id, 'bug', '', 'spec-fail', `run-specs: ${r.why}`], { stdio: 'inherit' }); bug++;
  } else if (r.passed && !r.skipped) {
    const layers = rows.find((x) => x.id === id)?.layers ?? '';
    execFileSync('node', [join(AIQA, 'mark.mjs'), area, id, 'pass', /\bui\b/.test(layers) ? layers : [layers, 'ui'].filter(Boolean).join(','), '-', `run-specs ${today()}`], { stdio: 'inherit' }); pass++;
  } else { console.log(`${id}: left as it is (${r.passed} passed, ${r.skipped} skipped)`); left++; }
}
console.log(`SUMMARY ${pass} pass, ${bug} bug, ${left} left; lines of the chosen specs that no test reported: ${[...new Set(chosen.flatMap((f) => [...coverage.get(f)]))].filter((i) => known.has(i) && !results.has(i)).length}`);
