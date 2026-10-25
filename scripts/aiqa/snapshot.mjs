#!/usr/bin/env node
// Saves the pages of an area as hashed parts: coverage/snapshots/<area>/<state>.json (states are listed in snapshots.config.json).
// node scripts/aiqa/snapshot.mjs <area>|all [state]      needs the dev stack (web :3000, API :8000)
import { areas } from './lib.mjs';
import { captureState, config, launch, prepare, saveState, waitForStack } from './snapshot-lib.mjs';

const [target, only] = process.argv.slice(2);
if (!target) { console.error('usage: snapshot.mjs <area>|all [state]'); process.exit(2); }
const cfg = config();
await waitForStack();
const browser = await launch();
try {
  const env = await prepare(browser);
  for (const area of target === 'all' ? Object.keys(cfg.areas) : [target]) {
    const states = cfg.areas[area]?.states;
    if (!states) { console.log(`${area}: no states in snapshots.config.json`); continue; }
    for (const [name, state] of Object.entries(states)) {
      if (only && only !== name) continue;
      const { variants, notes } = await captureState(browser, name, state, env, cfg);
      saveState(area, name, state, variants);
      const counts = Object.entries(variants).map(([k, v]) => `${k}=${Object.keys(v.parts).length}`).join(' ');
      console.log(`${area}/${name}: ${counts || 'nothing'}`);
      for (const n of notes) console.log(`  ${n}`);
    }
  }
} finally { await browser.close(); }
