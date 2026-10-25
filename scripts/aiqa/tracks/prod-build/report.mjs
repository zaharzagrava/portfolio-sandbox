#!/usr/bin/env node
// Writes scripts/aiqa/findings/prod-build.md from the recheck result and the monkey / fuzzer finding files.
//   node report.mjs <recheck.json> <monkeyDir|-> <fuzzDir|-> <meta.json>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const [recheckFile, monkeyDir, fuzzDir, metaFile] = process.argv.slice(2);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../../findings/prod-build.md');
const R = JSON.parse(fs.readFileSync(recheckFile, 'utf8'));
const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
const tsv = (d) => (d && d !== '-' && fs.existsSync(path.join(d, 'findings.tsv')) ? fs.readFileSync(path.join(d, 'findings.tsv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split('\t')) : null);
const count = (rows, server, kind) => rows.filter((r) => r.server === server).reduce((n, r) => n + r.errors.filter((e) => e.kind === kind).length, 0);
const pagesWith = (rows, server, kind) => new Set(rows.filter((r) => r.server === server && r.errors.some((e) => e.kind === kind)).map((r) => r.route));
const sample = (rows, server, kind) => rows.filter((r) => r.server === server).flatMap((r) => r.errors.filter((e) => e.kind === kind).map((e) => `${r.route}: ${e.text.slice(0, 150)}`))[0] ?? '';
const verdict = (devN, prodN) => (prodN > 0 ? 'REAL ON PRODUCTION' : devN > 0 ? 'DEV-ONLY NOISE' : 'NOT SEEN on either server');

let md = `# Production build re-check, monkey and API fuzzer\n\nRun ${R.when.slice(0, 16).replace('T', ' ')}. Production web server on ${R.prod} (build of the current sources${meta.copyBuild ? ', built from a copy without test files because the real build fails on test files, see S-6 in security.md' : ''}), dev server ${R.dev} as the control, API on :8000. ${R.routes} seller pages opened at desktop (1366) and phone (390) width by a brand-new seller on both servers.\n\n`;

md += `## Re-check of the findings that were only seen on the dev server\n\n| Bug | What | Dev server | Production | Verdict |\n|---|---|---|---|---|\n`;
const csp = [count(R.pages, 'dev', 'csp-style'), count(R.pages, 'prod', 'csp-style')];
const hyd = [count(R.pages, 'dev', 'hydration'), count(R.pages, 'prod', 'hydration')];
md += `| B-003 | "Applying inline style violates style-src" console errors | ${csp[0]} errors on ${pagesWith(R.pages, 'dev', 'csp-style').size} pages | ${csp[1]} errors on ${pagesWith(R.pages, 'prod', 'csp-style').size} pages | **${verdict(...csp)}** |\n`;
md += `| B-005 | Hydration mismatch console errors | ${hyd[0]} errors on ${pagesWith(R.pages, 'dev', 'hydration').size} pages | ${hyd[1]} errors on ${pagesWith(R.pages, 'prod', 'hydration').size} pages | **${verdict(...hyd)}** |\n`;
const nf = (s) => R.notFound.filter((r) => r.server === s);
const nf200 = (s) => nf(s).filter((r) => r.status === 200).length;
md += `| B-026 | Not-found pages answer HTTP 200 | ${nf200('dev')} of ${nf('dev').length} probes answer 200 | ${nf200('prod')} of ${nf('prod').length} probes answer 200 | **${verdict(nf200('dev'), nf200('prod'))}** |\n`;
const a401 = (s) => R.anonymous.filter((r) => r.server === s).reduce((n, r) => n + r.errors.filter((e) => e.kind === 'http-401').length, 0);
md += `| B-031 | 401 from /api/bff/session logged as a console error on first load | ${a401('dev')} console errors | ${a401('prod')} console errors | **${verdict(a401('dev'), a401('prod'))}** |\n\n`;

md += `### Evidence\n\n`;
for (const [id, kind] of [['B-003', 'csp-style'], ['B-005', 'hydration']]) {
  md += `- ${id}, dev example: ${sample(R.pages, 'dev', kind) || 'none'}\n- ${id}, production example: ${sample(R.pages, 'prod', kind) || 'none'}\n`;
}
const other = (s) => R.pages.filter((r) => r.server === s).flatMap((r) => r.errors.filter((e) => e.kind === 'other').map((e) => `${r.route}: ${e.text.slice(0, 140)}`));
md += `- Other console errors on production (not one of the four): ${other('prod').length}${other('prod').length ? '; first: ' + other('prod')[0] : ''}\n`;
md += `\nNot-found probes (status as the browser saw it):\n\n| Probe | Dev status | Production status | Production page says |\n|---|---|---|---|\n`;
for (const p of nf('prod')) md += `| ${p.probe} | ${nf('dev').find((d) => d.probe === p.probe)?.status} | ${p.status} | ${p.text.slice(0, 60)} |\n`;
md += `\nAnonymous first loads, 401 answers seen (production): ${R.anonymous.filter((r) => r.server === 'prod').map((r) => `${r.route}: ${r.responses401.join(', ') || 'none'}; console errors ${r.errors.length}`).join(' | ')}\n`;
md += `\nPages with the status that was not 200 on production: ${R.pages.filter((r) => r.server === 'prod' && r.status !== 200).map((r) => `${r.route} (${r.status})`).filter((v, i, s) => s.indexOf(v) === i).join(', ') || 'none'}\n\n`;

const mk = tsv(monkeyDir);
md += `## Monkey tester on the production build (${meta.minutes ?? '?'} minutes, seed ${meta.monkeySeed ?? '?'})\n\n`;
if (!mk) md += 'No findings file (the monkey did not run or stopped early; see the log).\n\n';
else {
  const by = {}; for (const r of mk) (by[r[0]] ??= []).push(r);
  md += `${mk.length} distinct findings. By kind: ${Object.entries(by).map(([k, v]) => `${v.length} x ${k}`).join(', ') || 'none'}.\n\n`;
  for (const [k, v] of Object.entries(by)) { md += `### ${k} (${v.length})\n\n`; for (const r of v.slice(0, 25)) md += `- ${r[1]} (${r[2]}): ${r[3].replace(/\s+/g, ' ').slice(0, 220)}\n`; md += '\n'; }
  md += `Full files: ${monkeyDir.replace(/.*\/specs\//, 'specs/')}\n\n`;
}
const fz = tsv(fuzzDir);
md += `## API fuzzer (${meta.minutes ?? '?'} minutes, seed ${meta.fuzzSeed ?? '?'})\n\nThe fuzzer talks to the API on :8000 directly (the web server is not in its path), so it behaves the same as on the dev stack; it was run again with a fresh seed.\n\n`;
if (!fz) md += 'No findings file (see the log).\n\n';
else {
  const byWhy = {}; for (const r of fz) (byWhy[r[3]] ??= []).push(r);
  md += `${fz.length} distinct findings.\n\n`;
  for (const [why, v] of Object.entries(byWhy).sort((a, b) => b[1].length - a[1].length)) { md += `- ${v.length} x ${why}: ${v.slice(0, 4).map((r) => `${r[0]} [${r[2]}]`).join('; ')}${v.length > 4 ? ' ...' : ''}\n`; }
  md += `\nFull file: ${fuzzDir.replace(/.*\/specs\//, 'specs/')}\n\n`;
}
const triage = path.join(HERE, 'triage.md');
md += `---\n\n## Verdicts after reading the evidence (by hand)\n\n` + (fs.existsSync(triage) ? fs.readFileSync(triage, 'utf8') : '_not triaged yet_\n');
fs.writeFileSync(OUT, md);
console.log('wrote scripts/aiqa/findings/prod-build.md');
