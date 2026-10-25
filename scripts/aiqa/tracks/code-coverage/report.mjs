#!/usr/bin/env node
// Lists the code of one area that NOTHING ever executed, from the recorded coverage, and proposes new map lines for it.
//   node scripts/aiqa/tracks/code-coverage/report.mjs <area> [--v8dir <folder>]... [--raw <folder>] [--append-to-map] [--all-seller]
// Reads: every web-*.json in specs/.checkpoints/coverage/raw (written by cover.mjs while a browser was used) and, for the server side of the web
// app and for the API, the folders that NODE_V8_COVERAGE filled (--v8dir, as often as needed; see README.md).
// Writes: scripts/aiqa/coverage/<area>.unexecuted.md (the list + the proposed map lines). With --append-to-map it also appends the proposed lines
// to coverage/<area>.tsv (never done unless you ask; lines whose id already exists are skipped).
import { existsSync, readdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { RAW_DIR, ROOT, functionsOfV8Dir } from './lib.mjs';

const args = process.argv.slice(2);
const area = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--v8dir' && args[args.indexOf(a) - 1] !== '--raw');
if (!area) { console.error('usage: report.mjs <area> [--v8dir <folder>]... [--raw <folder>] [--append-to-map] [--all-seller]'); process.exit(2); }
const flagValues = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
const v8dirs = flagValues('--v8dir');
const rawDir = flagValues('--raw')[0] ?? RAW_DIR;
const mapFile = join(ROOT, 'scripts/aiqa/coverage', `${area}.tsv`);
if (!existsSync(mapFile)) { console.error(`no map ${mapFile}`); process.exit(2); }

// ---- the scope of the area
const mapLines = readFileSync(mapFile, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => l.split('\t'));
const existingIds = new Set(mapLines.map((c) => c[0]));
const named = new Set(mapLines.flatMap((c) => c[3].match(/packages\/[\w@.[\]/-]+?\.(?:tsx?|mjs)/g) ?? []));
const IS_TEST = /\.(test|spec|mutation\.test|property\.test|e2e-spec)\.[tj]sx?$|\.stories\./;
function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...walk(p)); }
    else if (/\.(tsx?|mjs)$/.test(e.name) && !IS_TEST.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p.slice(ROOT.length + 1));
  }
  return out;
}
const webRoots = ['packages/web/components/seller', 'packages/web/app/dashboard/seller', 'packages/web/lib/seller'];
const allSeller = args.includes('--all-seller');
const inArea = (f) =>
  allSeller || named.has(f) || new RegExp(`/${area}(/|$)`).test(f);
const webScope = [...new Set([...webRoots.flatMap(walk), ...[...named].filter((f) => f.startsWith('packages/web/') && existsSync(join(ROOT, f)))])].filter(inArea).sort();
const backendScope = [...named].filter((f) => f.startsWith('packages/backend/') && existsSync(join(ROOT, f))).sort();

// ---- what ran
const executed = new Map(); // file|line|col -> {file,line,col,name,count}
const add = (fns) => { for (const f of fns) { const k = `${f.file}|${f.line}|${f.name}`; const p = executed.get(k); if (!p || f.count > p.count) executed.set(k, f); } };
const rawFiles = existsSync(rawDir) ? readdirSync(rawDir).filter((n) => n.endsWith('.json')) : [];
for (const n of rawFiles) { try { add(JSON.parse(readFileSync(join(rawDir, n), 'utf8')).functions ?? []); } catch { /* skip a broken file */ } }
let serverData = 0, backendData = 0;
for (const d of v8dirs) {
  const fns = functionsOfV8Dir(d);
  add(fns);
  for (const f of fns) { if (f.file.startsWith('packages/web/')) serverData += 1; else if (f.file.startsWith('packages/backend/')) backendData += 1; }
}
const byFile = new Map();
for (const f of executed.values()) { if (!byFile.has(f.file)) byFile.set(f.file, []); byFile.get(f.file).push(f); }

// ---- classify each file of the scope
const funcLabel = (f) => f.name || `anon@L${f.line}`;
const declared = (file) => { // the named functions of a file nobody loaded
  const text = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const out = [];
  text.forEach((line, i) => {
    const m = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/.exec(line) ?? /^(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>/.exec(line);
    if (m) out.push({ name: m[1], line: i + 1 });
  });
  return out;
};
const isServerSide = (file) => {
  if (/\.server\.tsx?$/.test(file) || /\/(page|layout|loading|not-found|error|route)\.tsx?$/.test(file) && file.includes('/app/')) return true;
  const text = readFileSync(join(ROOT, file), 'utf8');
  return file.includes('/components/') && !/^['"]use client['"]/m.test(text) && /\bimport 'server-only'|from 'server-only'/.test(text);
};
const report = []; // {file, kind, total, unexecuted:[{name,line}], note}
for (const file of [...webScope, ...backendScope]) {
  const isWeb = file.startsWith('packages/web/');
  const fns = byFile.get(file);
  if (fns?.length) {
    const un = fns.filter((f) => f.count === 0).map((f) => ({ name: funcLabel(f), line: f.line })).sort((a, b) => a.line - b.line);
    report.push({ file, kind: un.length ? 'partial' : 'all-run', total: fns.length, unexecuted: un });
    continue;
  }
  const clientish = isWeb && !isServerSide(file) && (/^['"]use client['"]/m.test(readFileSync(join(ROOT, file), 'utf8')) || file.includes('/lib/'));
  if (isWeb && !clientish && !serverData) { report.push({ file, kind: 'not-measured', total: 0, unexecuted: [], note: 'runs on the server (or could): no server coverage given (start the stack with QA_COVERAGE=1)' }); continue; }
  if (!isWeb && !backendData) { report.push({ file, kind: 'not-measured', total: 0, unexecuted: [], note: 'backend file: no API coverage given (--v8dir of an API started with QA_COVERAGE=1)' }); continue; }
  const d = declared(file);
  report.push({ file, kind: 'never-loaded', total: d.length, unexecuted: d });
}

// ---- proposed map lines
const idOf = (file, fn) => {
  const short = file.replace(/^packages\/(web|backend)\//, '').replace(/^(libs\/domains|app\/dashboard\/seller|components\/seller|lib\/seller)\//, '').replace(/\.[a-z]+$/, '').replace(/[[\]]/g, '').replace(/\//g, '-');
  return `${area}.coverage.${short}-${fn}`;
};
const today = new Date().toISOString().slice(0, 10);
const proposed = [];
const seen = new Set();
for (const r of report) {
  if (!r.unexecuted.length && r.kind !== 'never-loaded') continue;
  const layers = r.file.startsWith('packages/web/') ? 'ui' : 'api';
  const list = r.unexecuted.length ? r.unexecuted : [{ name: '(whole file)', line: 1 }];
  for (const u of list) {
    if (r.kind === 'never-loaded' && u.name.startsWith('anon@')) continue;
    const id = idOf(r.file, u.name.replace(/[^\w@.-]/g, ''));
    if (existingIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    const what = u.name === '(whole file)' ? `Code that no test or tester run has executed: the file ${basename(r.file)} (nothing in it ran). Find the screen or call that reaches it and exercise it.` : `Code that no test or tester run has executed: ${u.name} in ${basename(r.file)} (line ${u.line}). Find the screen or call that reaches it and exercise it.`;
    proposed.push(`${id}\t${what}\tnone\t${r.file}\t${layers}\tuntested\t\t\t\tfound by code coverage ${today}`);
  }
}

// ---- write the report
const count = (k) => report.filter((r) => r.kind === k).length;
const fnTotal = report.reduce((n, r) => n + r.total, 0), fnUn = report.reduce((n, r) => n + (r.kind === 'never-loaded' ? 0 : r.unexecuted.length), 0);
let md = `# Code that was never executed: ${area}\n\nGenerated ${new Date().toISOString()} by \`scripts/aiqa/tracks/code-coverage/report.mjs ${area}\`. Plain words: this is the list of code in the scope of the area that no browser session, tester or test recorded as running. Each entry is a place to look for a missing map line.\n\n`;
md += `Data used: ${rawFiles.length} browser recording(s) in \`${rawDir.replace(ROOT + '/', '')}\`, ${v8dirs.length} server coverage folder(s) (${serverData} web-server and ${backendData} API function records).\n\n`;
md += `Scope: ${webScope.length} web file(s) and ${backendScope.length} backend file(s)${allSeller ? ' (all of the seller scope)' : ' (files named in the map and the folders named after the area; --all-seller for the whole seller scope)'}.\n\n`;
md += `| Result | Files |\n|---|---|\n| some functions never ran | ${count('partial')} |\n| file never loaded (nothing ran) | ${count('never-loaded')} |\n| every recorded function ran | ${count('all-run')} |\n| not measured (no server data) | ${count('not-measured')} |\n\nIn the files that were loaded, ${fnUn} of ${report.filter((r) => r.kind !== 'never-loaded' && r.kind !== 'not-measured').reduce((n, r) => n + r.total, 0)} functions never ran. Unit tests (Vitest) are not counted here; only the real app.\n\n`;
for (const [kind, title] of [['partial', 'Loaded, but these functions never ran'], ['never-loaded', 'Never loaded: nothing in the file ran'], ['not-measured', 'Not measured (needs server coverage)']]) {
  const rows = report.filter((r) => r.kind === kind);
  if (!rows.length) continue;
  md += `## ${title}\n\n`;
  for (const r of rows) {
    md += `- \`${r.file}\`${r.note ? ` - ${r.note}` : ''}\n`;
    if (kind !== 'not-measured') for (const u of r.unexecuted.slice(0, 60)) md += `    - ${u.name} (line ${u.line})\n`;
    if (r.unexecuted.length > 60) md += `    - ... and ${r.unexecuted.length - 60} more\n`;
  }
  md += '\n';
}
md += `## Proposed map lines (${proposed.length}, status untested, spec none)\n\nTab-separated, same columns as \`coverage/${area}.tsv\`. Add them with \`--append-to-map\`, or give each a justified \`n/a\`.\n\n\`\`\`\n${proposed.join('\n')}\n\`\`\`\n`;
writeFileSync(join(ROOT, 'scripts/aiqa/coverage', `${area}.unexecuted.md`), md);
if (args.includes('--append-to-map') && proposed.length) appendFileSync(mapFile, proposed.join('\n') + '\n');
console.log(`${area}: ${report.length} files in scope: ${count('partial')} partly run, ${count('never-loaded')} never loaded, ${count('all-run')} fully run, ${count('not-measured')} not measured; ${proposed.length} map lines proposed -> scripts/aiqa/coverage/${area}.unexecuted.md`);
