#!/usr/bin/env node
// Saves the pages of an area as hashed parts: coverage/snapshots/<area>/<state>.json (states are listed in snapshots.config.json).
// node scripts/aiqa/snapshot.mjs <area>|all [state] [--roles=viewer,staff,admin]      needs the dev stack (web :3000, API :8000)
import { areas } from './lib.mjs';
import { captureState, config, launch, loadState, prepare, saveState, waitForStack } from './snapshot-lib.mjs';

const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const [target, only] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const onlyRoles = flags.find((f) => f.startsWith('--roles='))?.slice(8).split(',') ?? null; // e.g. --roles=viewer,staff: take those variants only, keep the others
if (!target) { console.error('usage: snapshot.mjs <area>|all [state] [--roles=viewer,staff,admin]'); process.exit(2); }
const cfg = config();
await waitForStack();
const browser = await launch();
try {
  const env = await prepare(browser, cfg, target);
  for (const area of target === 'all' ? Object.keys(cfg.areas) : [target]) {
    const states = cfg.areas[area]?.states;
    if (!states) { console.log(`${area}: no states in snapshots.config.json`); continue; }
    for (const [name, state] of Object.entries(states)) {
      if (only && only !== name) continue;
      const { variants, notes } = await captureState(browser, name, state, env, cfg, onlyRoles);
      const kept = onlyRoles ? loadState(area, name)?.variants ?? {} : {};
      if (onlyRoles && !Object.keys(variants).length) { for (const n of notes) console.log(`${area}/${name}: ${n}`); continue; }
      saveState(area, name, state, { ...kept, ...variants });
      const counts = Object.entries(variants).map(([k, v]) => `${k}=${Object.keys(v.parts).length}`).join(' ');
      console.log(`${area}/${name}: ${counts || 'nothing'}`);
      for (const n of notes) console.log(`  ${n}`);
    }
  }
} finally { await browser.close(); }
