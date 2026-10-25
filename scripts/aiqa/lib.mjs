// Shared helpers of the AI QA cache: reading the maps, finding the code and spec files a line names, hashing them.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AIQA = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(AIQA, '..', '..');
export const COVERAGE = process.env.AIQA_COVERAGE_DIR ? resolve(process.env.AIQA_COVERAGE_DIR) : join(AIQA, 'coverage');
export const COLS = ['id', 'what', 'spec', 'code', 'layers', 'status', 'date', 'by', 'bugs', 'note'];
export const today = () => new Date().toISOString().slice(0, 10);
export const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export const areas = () => readdirSync(COVERAGE).filter((f) => f.endsWith('.tsv')).map((f) => f.replace(/\.tsv$/, '')).sort();

/** Map lines as objects (with `row` = the index in the file's line array). */
export function loadMap(area) {
  const lines = readFileSync(join(COVERAGE, `${area}.tsv`), 'utf8').split('\n');
  const rows = [];
  lines.forEach((l, row) => {
    if (!l || l.startsWith('#') || l.startsWith('id\t')) return;
    rows.push({ ...Object.fromEntries(l.split('\t').map((v, i) => [COLS[i], v])), row });
  });
  return rows;
}

// ---------------------------------------------------------------- code files
let fileIndex;
function files() {
  fileIndex ??= execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: REPO, maxBuffer: 1 << 28 }).toString().split('\n').filter(Boolean);
  return fileIndex;
}
const EXT = 'tsx?|mjs|cjs|jsx?|json|css|sql|sh|ya?ml|prisma|md';
const PATH_RE = new RegExp(`[\\w@\\[\\]().*{}/-]*[\\w\\]*)]\\.(?:${EXT})(?![\\w])`, 'g');

const SRC_RE = /^packages\/(web|backend|contracts)\/.*\.(ts|tsx)$/;
const NOT_SRC = /(node_modules|\/dist\/|\.next\/|\.spec\.|\.test\.|\.e2e-spec\.|\/tests?\/|\/test-utils\/|\.d\.ts$)/;
const read = (rel) => { try { return readFileSync(join(REPO, rel), 'utf8'); } catch { return ''; } };

let symbols, tables, migrations;
/** name -> [files] of definitions (class, function, const, type...) in the web, backend and contracts sources. */
function symbolIndex() {
  if (symbols) return symbols;
  symbols = new Map(); tables = new Map();
  const def = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|function\*?|const|let|enum|interface|type)\s+([A-Za-z_$][\w$]*)/gm;
  for (const f of files()) {
    if (!SRC_RE.test(f) || NOT_SRC.test(f)) continue;
    const text = read(f);
    for (const m of text.matchAll(def)) { const l = symbols.get(m[1]) ?? []; if (!l.includes(f)) l.push(f); symbols.set(m[1], l); }
    for (const m of text.matchAll(/tableName:\s*['"](\w+)['"]/g)) tables.set(m[1], f);
  }
  return symbols;
}
/** Migration files that touch a table: they quote its name. */
function migrationsOf(table) {
  migrations ??= files().filter((f) => /^packages\/backend\/migrations(-\w+)?\/.*\.[cm]?js$/.test(f)).map((f) => [f, read(f)]);
  const q = `["'\`]${table}["'\`]`;
  const re = new RegExp(`\\.(?:createTable|addColumn|removeColumn|changeColumn|renameColumn|addIndex|removeIndex|dropTable|addConstraint|removeConstraint|renameTable|bulkInsert|bulkDelete|bulkUpdate)\\(\\s*${q}|(?:ALTER|CREATE|DROP)\\s+TABLE\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?"?${table}"?[\\s(;]`);
  return migrations.filter(([, t]) => re.test(t)).map(([f]) => f);
}
const STOP = new Set(['None', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'API', 'UI', 'DB', 'URL', 'HTML', 'JSON', 'Next', 'React', 'Props']);

/** Source files an imported file leans on: API clients (packages/web/lib/api), and the contracts (zod schemas, types) it imports by name. */
function importDeps(rel) {
  const out = new Set();
  const text = read(rel);
  for (const m of text.matchAll(/import\s+(?:type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g)) {
    const from = m[3];
    if (from === '@marketplace-sandbox/contracts' || from.startsWith('@marketplace-sandbox/contracts/')) {
      for (const n of (m[2] ?? '').split(',').map((x) => x.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean)) {
        const hits = (symbolIndex().get(n) ?? []).filter((f) => f.startsWith('packages/contracts/'));
        if (hits.length && hits.length <= 2) hits.forEach((h) => out.add(h));
      }
    } else if (from.startsWith('.') || from.startsWith('@/')) {
      const base = from.startsWith('@/') ? join('packages/web', from.slice(2)) : join(dirname(rel), from);
      for (const c of [base + '.ts', base + '.tsx', join(base, 'index.ts')]) {
        if (files().includes(c) && (/^packages\/web\/lib\/api\//.test(c) || /\.(dto|schema|contract)s?\.ts$/.test(c))) out.add(c);
      }
    }
  }
  return out;
}

/** Everything a `code` cell depends on: named files, definitions of named symbols (classes, hooks, services), the table models and migrations of named tables, the API client and contracts those files use. */
export function codeFiles(cell) {
  cell = cell ?? '';
  const found = new Set(), unknown = [];
  for (const m of cell.matchAll(PATH_RE)) {
    const token = m[0].replace(/^\(+/, '');
    const hits = resolveToken(token);
    if (hits.length) hits.forEach((h) => found.add(h)); else unknown.push(token);
  }
  const rest = cell.replace(PATH_RE, ' ');
  symbolIndex();
  for (const m of rest.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const t = m[0];
    if (tables.has(t)) { found.add(tables.get(t)); migrationsOf(t).forEach((f) => found.add(f)); continue; }
    if (t.length < 4 || STOP.has(t) || !/[A-Z]/.test(t)) continue;
    const hits = symbols.get(t);
    if (hits && hits.length <= 3) hits.forEach((h) => found.add(h));
  }
  for (const f of [...found]) if (/\.(ts|tsx)$/.test(f)) importDeps(f).forEach((d) => found.add(d));
  return { files: [...found].sort(), unknown };
}

function resolveToken(token) {
  const all = files();
  if (token.includes('*')) {
    const re = new RegExp('(^|/)' + token.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*') + '$');
    return all.filter((f) => re.test(f));
  }
  for (const base of ['', 'packages/web/', 'packages/backend/', 'packages/']) {
    if (all.includes(base + token)) return [base + token];
  }
  const tail = '/' + token;
  const hits = all.filter((f) => f.endsWith(tail) && !f.includes('node_modules/'));
  return hits.length && hits.length <= 3 ? hits : [];
}

export function hashFile(rel) {
  const p = join(REPO, rel);
  return existsSync(p) ? sha(readFileSync(p)) : 'MISSING';
}

// ---------------------------------------------------------------- spec sections
const SPEC_DIR = join(REPO, 'docs', 'spec', 'capabilities');
/** Spec ids of a `spec` cell: "W04.AS-84", "S10.R-39", "W04" (whole file). Others (W04.F6, "spec", FR-002) are kept as the capability only. */
export function specIds(cell) {
  const out = new Set();
  for (const m of (cell ?? '').matchAll(/\b([WSJ]\d{2})(?:\.([A-Za-z][\w-]*\d+(?:-\d+)?))?/g)) out.add(m[2] ? `${m[1]}.${m[2]}` : m[1]);
  return [...out].sort();
}
const specText = new Map();
function specFile(cap) {
  if (!specText.has(cap)) {
    const f = readdirSync(SPEC_DIR).find((n) => n.startsWith(cap + '-'));
    specText.set(cap, f ? { file: `docs/spec/capabilities/${f}`, text: readFileSync(join(SPEC_DIR, f), 'utf8') } : null);
  }
  return specText.get(cap);
}
/** Hash of what the spec says about an id: the lines that mention it (e.g. "- **W04.R-02** ..."), else the whole capability file. */
export function specHash(id) {
  const [cap, local] = id.split('.');
  const f = specFile(cap);
  if (!f) return { hash: 'MISSING', file: null };
  if (local) {
    const re = new RegExp(`(?<![\\w-])${local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
    const lines = f.text.split('\n').filter((l) => re.test(l));
    if (lines.length) return { hash: sha(lines.join('\n')), file: f.file };
  }
  return { hash: sha(f.text), file: f.file };
}

/** The fingerprint of one map line right now. */
export function fingerprintOf(row) {
  const { files: fs, unknown } = codeFiles(row.code);
  const codeParts = Object.fromEntries(fs.map((f) => [f, hashFile(f)]));
  const specParts = Object.fromEntries(specIds(row.spec).map((id) => [id, specHash(id).hash]));
  return {
    fp: { code: sha(JSON.stringify(codeParts)), spec: sha(JSON.stringify(specParts)), at: today(), files: codeParts, specs: specParts },
    unknown,
  };
}

export const fpFile = (area) => join(COVERAGE, `${area}.fingerprints.json`);
export const readFps = (area) => (existsSync(fpFile(area)) ? JSON.parse(readFileSync(fpFile(area), 'utf8')) : {});
export const writeFps = (area, data) => {
  const sorted = Object.fromEntries(Object.keys(data).sort().map((k) => [k, data[k]]));
  writeFileSync(fpFile(area), JSON.stringify(sorted, null, 1) + '\n');
};

/** What changed between a stored fingerprint and now: list of file paths / spec ids. */
export function diffFp(old, now) {
  if (old.code === now.code && old.spec === now.spec) return [];
  const out = [];
  for (const [k, v] of Object.entries(now.files)) if (old.files?.[k] !== v) out.push(old.files?.[k] === undefined ? `${k} (new)` : k);
  for (const k of Object.keys(old.files ?? {})) if (!(k in now.files)) out.push(`${k} (gone)`);
  for (const [k, v] of Object.entries(now.specs)) if (old.specs?.[k] !== v) out.push(`spec ${k}`);
  return out.length ? out : ['(fingerprint)'];
}

// ---------------------------------------------------------------- writing one map line under a lock
export async function withLock(file, fn) {
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break; } catch { if (i > 300) { console.error('lock busy'); process.exit(3); } await new Promise((r) => setTimeout(r, 100)); }
  }
  try { return fn(); } finally { rmdirSync(lock); }
}

/** Edits one line (by id) of a map: `edit(cells)` mutates the 10 cells. Caller holds the lock. */
export function editLine(area, id, edit) {
  const file = join(COVERAGE, `${area}.tsv`);
  const lines = readFileSync(file, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.split('\t')[0] === id);
  if (at < 0) return false;
  const c = lines[at].split('\t'); while (c.length < 10) c.push('');
  edit(c);
  lines[at] = c.join('\t');
  writeFileSync(file, lines.join('\n'));
  return true;
}
