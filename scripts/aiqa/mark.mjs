#!/usr/bin/env node
// Updates ONE line of a coverage map (safe with several agents at once: re-reads the file, takes a lock, writes back).
// node scripts/aiqa/mark.mjs <area> <id> <status> <layers> <bugs|-> "<note>"
import { readFileSync, writeFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [area, id, status, layers, bugs, note = ''] = process.argv.slice(2);
if (!area || !id || !status) { console.error('usage: mark.mjs <area> <id> <status> <layers> <bugs|-> "<note>"'); process.exit(2); }
if (!['untested', 'pass', 'bug', 'blocked', 'n/a'].includes(status)) { console.error(`bad status ${status}`); process.exit(2); }
const dir = join(dirname(fileURLToPath(import.meta.url)), 'coverage');
const file = join(dir, `${area}.tsv`);
const lock = `${file}.lock`;
for (let i = 0; ; i++) {
  try { mkdirSync(lock); break; } catch { if (i > 300) { console.error('lock busy'); process.exit(3); } await new Promise((r) => setTimeout(r, 100)); }
}
try {
  const lines = readFileSync(file, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.split('\t')[0] === id);
  if (at < 0) { console.error(`no line ${id}`); process.exit(2); }
  const c = lines[at].split('\t'); while (c.length < 10) c.push('');
  c[4] = layers || c[4]; c[5] = status; c[6] = new Date().toISOString().slice(0, 10); c[7] = 'ai-tester';
  c[8] = bugs === '-' ? '' : bugs; c[9] = note.replace(/[\t\n]/g, ' ');
  lines[at] = c.join('\t');
  writeFileSync(file, lines.join('\n'));
  console.log(`${id}: ${status}`);
} finally { rmdirSync(lock); }
