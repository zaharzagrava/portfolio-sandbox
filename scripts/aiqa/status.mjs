#!/usr/bin/env node
// Prints how much of each coverage map is checked. `node scripts/aiqa/status.mjs [area]` lists the open lines of one area.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'coverage');
const only = process.argv[2];
const COLS = ['id', 'what', 'spec', 'code', 'layers', 'status', 'date', 'by', 'bugs', 'note'];
const STATUSES = ['untested', 'pass', 'bug', 'blocked', 'n/a'];

function load(file) {
  return readFileSync(join(dir, file), 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('id\t'))
    .map((l) => Object.fromEntries(l.split('\t').map((v, i) => [COLS[i], v])));
}

const files = readdirSync(dir).filter((f) => f.endsWith('.tsv') && (!only || f === `${only}.tsv`));
let total = 0, checked = 0, problems = 0;
for (const f of files) {
  const rows = load(f);
  const n = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of rows) {
    if (!STATUSES.includes(r.status)) { console.log(`${f}: ${r.id}: unknown status "${r.status}"`); problems++; continue; }
    n[r.status]++;
    if (r.status === 'pass' && !/\bui\b/.test(r.layers ?? '')) { console.log(`${f}: ${r.id}: "pass" without ui in layers`); problems++; }
  }
  const done = n.pass + n.bug + n['n/a'];
  total += rows.length; checked += done;
  console.log(`${f.replace('.tsv', '').padEnd(12)} ${String(rows.length).padStart(4)} lines  checked ${String(done).padStart(4)} (${rows.length ? Math.round((100 * done) / rows.length) : 0}%)  pass ${n.pass}  bug ${n.bug}  blocked ${n.blocked}  untested ${n.untested}`);
  if (only) for (const r of rows.filter((x) => x.status === 'untested' || x.status === 'blocked')) console.log(`  ${r.status.padEnd(9)} ${r.id}  ${r.what}`);
}
console.log(`TOTAL ${total} lines, checked ${checked}${total ? ` (${Math.round((100 * checked) / total)}%)` : ''}`);
process.exit(problems ? 1 : 0);
