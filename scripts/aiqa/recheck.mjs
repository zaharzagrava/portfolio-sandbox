#!/usr/bin/env node
// Sends lines whose code or spec changed since they were checked back to `untested`.
// node scripts/aiqa/recheck.mjs <area>|all [--dry]
import { areas, diffFp, editLine, fingerprintOf, loadMap, readFps, today, withLock, COVERAGE } from './lib.mjs';
import { join } from 'node:path';

const [target, ...flags] = process.argv.slice(2);
if (!target) { console.error('usage: recheck.mjs <area>|all [--dry]'); process.exit(2); }
const dry = flags.includes('--dry');
let total = 0;
for (const area of target === 'all' ? areas() : [target]) {
  const stored = readFps(area);
  const changed = [];
  let noFp = 0, same = 0;
  for (const row of loadMap(area)) {
    if (row.status !== 'pass' && row.status !== 'bug') continue;
    const old = stored[row.id];
    if (!old) { noFp++; continue; }
    const why = diffFp(old, fingerprintOf(row).fp);
    if (why.length) changed.push({ row, why }); else same++;
  }
  console.log(`${area}: ${changed.length} changed, ${same} unchanged, ${noFp} checked lines without a stored fingerprint`);
  for (const { row, why } of changed) console.log(`  ${row.id} (${row.status}): changed: ${why.join(', ')}`);
  total += changed.length;
  if (dry || !changed.length) continue;
  await withLock(join(COVERAGE, `${area}.tsv`), () => {
    for (const { row, why } of changed) {
      editLine(area, row.id, (c) => {
        const was = c[5];
        c[5] = 'untested'; c[6] = today(); c[7] = 'recheck';
        c[9] = `changed: ${why.join(', ')} (was ${was})`.replace(/[\t\n]/g, ' ');
      });
    }
  });
}
console.log(`TOTAL ${total} line${total === 1 ? '' : 's'} ${dry ? 'would be set' : 'set'} back to untested`);
