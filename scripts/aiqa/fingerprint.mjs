#!/usr/bin/env node
// Stores a fingerprint (hash of the code files + hash of the spec lines a map line names) for map lines.
// node scripts/aiqa/fingerprint.mjs <area>|all [--force]
// Without --force only lines that have no stored fingerprint, or are not checked yet (untested/blocked), get one: a checked line
// keeps its old fingerprint, so a change since the check is not hidden. mark.mjs records the fingerprint when a tester marks pass.
import { areas, fingerprintOf, loadMap, readFps, writeFps, withLock, fpFile } from './lib.mjs';

const [target, ...flags] = process.argv.slice(2);
if (!target) { console.error('usage: fingerprint.mjs <area>|all [--force]'); process.exit(2); }
const force = flags.includes('--force');
for (const area of target === 'all' ? areas() : [target]) {
  await withLock(fpFile(area), () => {
    const stored = readFps(area);
    let wrote = 0, kept = 0, noFiles = 0;
    const unknown = new Map();
    for (const row of loadMap(area)) {
      const { fp, unknown: bad } = fingerprintOf(row);
      for (const b of bad) unknown.set(b, [...(unknown.get(b) ?? []), row.id]);
      if (!Object.keys(fp.files).length) noFiles++;
      const checked = row.status === 'pass' || row.status === 'bug';
      if (stored[row.id] && checked && !force) { kept++; continue; }
      stored[row.id] = fp; wrote++;
    }
    writeFps(area, stored);
    console.log(`${area}: ${wrote} fingerprints written, ${kept} kept, ${noFiles} lines name no code file`);
    for (const [token, ids] of unknown) console.log(`  unknown path "${token}" (${ids.length} line${ids.length > 1 ? 's' : ''}, e.g. ${ids[0]})`);
  });
}
