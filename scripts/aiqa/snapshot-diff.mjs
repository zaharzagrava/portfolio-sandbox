#!/usr/bin/env node
// Re-snapshots an area, prints added / removed / changed parts, sends the map lines that match a changed part back to `untested`,
// and prints parts that match no line as "new control not in the map". The new snapshot becomes the stored one.
// node scripts/aiqa/snapshot-diff.mjs <area>|all [--dry] [state]
import { join } from 'node:path';
import { COVERAGE, editLine, loadMap, today, withLock } from './lib.mjs';
import { captureState, config, launch, loadState, prepare, saveState, waitForStack } from './snapshot-lib.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const [target, only] = args.filter((a) => !a.startsWith('--'));
if (!target) { console.error('usage: snapshot-diff.mjs <area>|all [--dry] [state]'); process.exit(2); }
const MAX_LINES = 12; // a label that matches more lines than this is too generic to map

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function linesFor(rows, label, idRe) {
  const text = label.replace(/\s+/g, ' ').trim();
  if (text.length < 3 || /^[\d\s.,{}]+$/.test(text)) return null; // nothing to match on
  const re = new RegExp(`(?<![\\w])${esc(text)}(?![\\w])`, 'i');
  return rows.filter((r) => idRe.test(r.id) && re.test(r.what));
}

const cfg = config();
await waitForStack();
const browser = await launch();
const toReset = new Map(); // area -> Map(lineId -> reason)
let newControls = 0, changedParts = 0;
try {
  const env = await prepare(browser);
  for (const area of target === 'all' ? Object.keys(cfg.areas) : [target]) {
    const states = cfg.areas[area]?.states;
    if (!states) { console.log(`${area}: no states in snapshots.config.json`); continue; }
    const rows = loadMap(area);
    for (const [name, state] of Object.entries(states)) {
      if (only && only !== name) continue;
      const idRe = new RegExp(state.ids ?? `^${area}\\.`);
      const before = loadState(area, name);
      const { variants, notes } = await captureState(browser, name, state, env, cfg);
      for (const n of notes) console.log(`${area}/${name}: ${n}`);
      if (!before) { console.log(`${area}/${name}: first snapshot (${Object.keys(variants).length} variants), nothing to compare`); if (!dry) saveState(area, name, state, variants); continue; }
      const merged = { ...before.variants };
      for (const [vkey, now] of Object.entries(variants)) {
        merged[vkey] = now;
        const old = before.variants[vkey];
        if (!old) { console.log(`${area}/${name} [${vkey}]: new variant, nothing to compare`); continue; }
        const diffs = [];
        for (const [k, p] of Object.entries(now.parts)) {
          if (!old.parts[k]) diffs.push(['added', k, p]);
          else if (old.parts[k].hash !== p.hash) diffs.push(['changed', k, p]);
        }
        for (const [k, p] of Object.entries(old.parts)) if (!now.parts[k]) diffs.push(['removed', k, p]);
        if (!diffs.length) { console.log(`${area}/${name} [${vkey}]: no change (${Object.keys(now.parts).length} parts)`); continue; }
        console.log(`${area}/${name} [${vkey}]:`);
        for (const [kind, key, p] of diffs) {
          changedParts++;
          const hit = p.label ? linesFor(rows, p.label, idRe) : null;
          let verdict;
          if (hit && hit.length && hit.length <= MAX_LINES) {
            verdict = `lines: ${hit.map((r) => r.id).join(', ')}`;
            for (const r of hit) {
              if (!toReset.has(area)) toReset.set(area, new Map());
              toReset.get(area).set(r.id, `ui ${kind}: ${p.role} "${p.label}" (${name}, ${vkey})`);
            }
          } else if (hit && hit.length > MAX_LINES) verdict = `too generic: "${p.label}" matches ${hit.length} lines`;
          else if ((kind === 'added') && (p.kind === 'control' || p.kind === 'dialog')) { verdict = 'new control not in the map'; newControls++; }
          else verdict = 'no map line matches';
          console.log(`  ${kind.padEnd(7)} ${key.slice(0, 80)}  -> ${verdict}`);
        }
      }
      if (!dry) saveState(area, name, state, merged);
    }
  }
} finally { await browser.close(); }

let reset = 0;
for (const [area, ids] of toReset) {
  const byId = new Map(loadMap(area).map((r) => [r.id, r]));
  const todo = [...ids].filter(([id]) => ['pass', 'bug'].includes(byId.get(id)?.status));
  console.log(`${area}: ${ids.size} lines match a changed part, ${todo.length} of them were checked${dry ? ' (dry: nothing written)' : ''}`);
  reset += todo.length;
  if (dry || !todo.length) continue;
  await withLock(join(COVERAGE, `${area}.tsv`), () => {
    for (const [id, why] of todo) editLine(area, id, (c) => { const was = c[5]; c[5] = 'untested'; c[6] = today(); c[7] = 'snapshot-diff'; c[9] = `${why} (was ${was})`.replace(/[\t\n]/g, ' '); });
  });
}
console.log(`SUMMARY ${changedParts} changed parts, ${reset} lines ${dry ? 'would go' : 'set'} back to untested, ${newControls} new control(s) not in the map`);
