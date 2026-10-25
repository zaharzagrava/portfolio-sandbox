#!/usr/bin/env node
// Prints the tests that look flaky, from specs/.checkpoints/test-history.jsonl (written when a run has TEST_HISTORY=1).
//   node scripts/aiqa/flaky.mjs [history-file] [--runs=20]
// A test is on the list when (a) it failed AND passed on the same commit, or (b) it failed more than once in its last 20 runs.
// A run = one invocation of the suite (field `run`); a retry inside a run counts as part of that run (fail then pass = failed once, flaky in the run).
// A test on this list is a bug to investigate, never one to retry.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = args.find((a) => !a.startsWith('--')) ?? join(root, 'specs/.checkpoints/test-history.jsonl');
const LAST = Number((args.find((a) => a.startsWith('--runs=')) ?? '--runs=20').split('=')[1]);
if (!existsSync(file)) {
  console.log(`No history yet (${file}). Run a suite with TEST_HISTORY=1 first (see scripts/aiqa/tracks/flaky-history/README.md).`);
  process.exit(0);
}
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const bad = (r) => r === 'failed' || r === 'timedOut';
const tests = new Map();
for (const l of lines) {
  if (l.result === 'skipped') continue;
  const key = `${l.file} :: ${l.name}${l.project ? ` [${l.project}]` : ''}`;
  if (!tests.has(key)) tests.set(key, []);
  tests.get(key).push(l);
}
const findings = [];
for (const [key, list] of tests) {
  // group the attempts into runs
  const runs = new Map();
  for (const l of list) {
    const r = runs.get(l.run) ?? { run: l.run, commit: l.commit, date: l.date, failed: false, passed: false };
    if (bad(l.result)) r.failed = true;
    else if (l.result === 'passed') r.passed = true;
    runs.set(l.run, r);
  }
  const ordered = [...runs.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const recent = ordered.slice(-LAST);
  const failedRuns = recent.filter((r) => r.failed).length;
  const byCommit = new Map();
  for (const r of ordered) {
    const c = byCommit.get(r.commit) ?? { failed: 0, passed: 0, retried: 0 };
    if (r.failed) c.failed += 1;
    if (r.passed) c.passed += 1;
    if (r.failed && r.passed) c.retried += 1;
    byCommit.set(r.commit, c);
  }
  const mixed = [...byCommit.entries()].filter(([, c]) => (c.failed && c.passed) || c.retried);
  const why = [];
  for (const [commit, c] of mixed)
    why.push(c.retried && !(c.failed > c.retried && c.passed > c.retried)
      ? `failed and then passed on a retry inside one run of commit ${commit}`
      : `both failed and passed on the same commit ${commit} (${c.failed} failing run(s), ${c.passed} passing run(s))`);
  if (failedRuns > 1) why.push(`failed in ${failedRuns} of its last ${recent.length} runs`);
  if (why.length) findings.push({ key, why, runs: ordered.length, failedRuns });
}
console.log(`History: ${lines.length} test results, ${tests.size} different tests, from ${file}`);
if (!findings.length) {
  console.log('No flaky test found: nothing both failed and passed on one commit, and nothing failed more than once in its last runs.');
  process.exit(0);
}
console.log(`\n${findings.length} test(s) to investigate (a test here is a bug to understand, never one to retry):\n`);
for (const f of findings.sort((a, b) => b.failedRuns - a.failedRuns)) {
  console.log(`- ${f.key}`);
  for (const w of f.why) console.log(`    ${w}`);
}
process.exit(1);
