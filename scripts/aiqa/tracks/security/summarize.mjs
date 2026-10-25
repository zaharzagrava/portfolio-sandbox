#!/usr/bin/env node
// Turns the raw output of one scanner into a short plain-language page: scripts/aiqa/findings/security-<tool>.md
//   node summarize.mjs <semgrep|gitleaks|audit|schemathesis|zap> <rawDir>
// The hand-written verdicts ("real or false alarm") live in triage/<tool>.md and are appended, so a re-run never loses them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [tool, raw] = process.argv.slice(2);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../../findings');
const rd = (f) => JSON.parse(fs.readFileSync(path.join(raw, f), 'utf8'));
const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
let md = '';
const by = (arr, f) => arr.reduce((m, x) => ((m[f(x)] ??= []).push(x), m), {});

if (tool === 'semgrep') {
  const r = rd('semgrep.json');
  md += `# Security: Semgrep (code rules)\n\nRun ${date}. Semgrep read the code of the four areas (web: seller pages, seller components, seller lib, API client; backend: catalog, media, orders, tenancy; test files left out) with the rule sets p/typescript, p/react, p/nodejs, p/owasp-top-ten, p/secrets and our own rules in \`security/semgrep-rules.yml\`.\n\n`;
  md += `Result: ${r.results.length} flags, ${r.errors.length} scan errors.\n\n`;
  for (const [rule, list] of Object.entries(by(r.results, (x) => x.check_id.split('.').pop()))) {
    md += `## ${rule} (${list.length})\n\n${list[0].extra.message.replace(/\s+/g, ' ')}\n\n`;
    for (const x of list) md += `- \`${x.path}:${x.start.line}\` ${x.extra.severity}\n`;
    md += '\n';
  }
}
if (tool === 'gitleaks') {
  const r = rd('gitleaks.json');
  md += `# Security: gitleaks (secrets in the code and its history)\n\nRun ${date}. Looks for passwords, keys and tokens in the whole git history and in the files of the working copy that git does not ignore.\n\nResult: ${r.length} flags.\n\n`;
  for (const x of r) md += `- \`${x.File}:${x.StartLine}\` rule ${x.RuleID}${x.Commit ? ` (commit ${x.Commit.slice(0, 8)})` : ' (working copy)'}: \`${(x.Match || '').replace(/\s+/g, ' ').slice(0, 70)}\`\n`;
}
if (tool === 'audit') {
  md += `# Security: dependency audit (pnpm audit --prod)\n\nRun ${date}. Known holes in the packages the web app and the API ship with. \`pnpm audit\` checks the whole lock file, so the list is split by which package pulls the dependency in.\n\n`;
  for (const p of ['web', 'backend']) {
    const r = rd(`audit-${p}.json`);
    const rows = Object.values(r.advisories).map((a) => ({ a, hit: a.findings.filter((f) => f.paths.some((x) => x.startsWith(`packages__${p}>`))) })).filter((x) => x.hit.length);
    const c = { critical: 0, high: 0, moderate: 0, low: 0 };
    for (const { a } of rows) c[a.severity] = (c[a.severity] ?? 0) + 1;
    md += `## packages/${p}: ${rows.length} advisories (critical ${c.critical}, high ${c.high}, moderate ${c.moderate}, low ${c.low})\n\n`;
    const order = ['critical', 'high', 'moderate', 'low'];
    rows.sort((x, y) => order.indexOf(x.a.severity) - order.indexOf(y.a.severity));
    for (const { a, hit } of rows.filter((x) => ['critical', 'high'].includes(x.a.severity)))
      md += `- ${a.severity.toUpperCase()} \`${a.module_name}\` ${hit[0].version} (fixed in ${a.patched_versions || 'no fix yet'}): ${a.title} ${a.url}\n`;
    md += `\n(moderate and low: ${rows.filter((x) => !['critical', 'high'].includes(x.a.severity)).map((x) => x.a.module_name).filter((v, i, s) => s.indexOf(v) === i).join(', ')})\n\n`;
  }
}
if (tool === 'schemathesis') {
  const txt = fs.readFileSync(path.join(raw, 'schemathesis.txt'), 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  md += `# Security: Schemathesis (API fuzzing from the OpenAPI document)\n\nRun ${date}. Schemathesis reads the API description and sends generated requests (valid, edge and invalid) to every operation of the four areas, with a test API key of the demo seller, and checks the answers against the description (no 5xx, right status codes and content types, bodies match the schema, no access without a key, other users' objects not reachable).\n\n## Raw result (end of the log)\n\n\`\`\`\n${txt.split('\n').slice(-120).join('\n')}\n\`\`\`\n`;
}
if (tool === 'zap') {
  const r = rd('zap.json');
  md += `# Security: OWASP ZAP baseline (production-build web server, port 3100)\n\nRun ${date}. The baseline scan opens the site, spiders it for a minute and passively checks every response (headers, cookies, leaked info). It does not attack.\n\n`;
  for (const s of r.site ?? []) {
    md += `Site ${s['@name']}: ${s.alerts.length} kinds of alert.\n\n`;
    for (const a of s.alerts) md += `- risk ${a.riskdesc}: **${a.name}** (${a.count} places), example \`${a.instances?.[0]?.uri ?? ''}\`\n`;
  }
}
const triage = path.join(HERE, 'triage', `${tool}.md`);
md += `\n---\n\n## Verdicts after reading the code (by hand)\n\n` + (fs.existsSync(triage) ? fs.readFileSync(triage, 'utf8') : '_not triaged yet_\n');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `security-${tool}.md`), md);
console.log(`wrote findings/security-${tool}.md`);
