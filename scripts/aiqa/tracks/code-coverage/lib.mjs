// Shared helpers of the code-coverage track: turn V8 function coverage of a bundled script into coverage of the ORIGINAL source files
// (through the script's source map), and find the repo paths. No dependency to install: @jridgewell/trace-mapping comes from the pnpm store.
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..', '..', '..');
export const RAW_DIR = process.env.QA_COVERAGE_DIR || join(ROOT, 'specs/.checkpoints/coverage/raw');

function loadTraceMapping() {
  const req = createRequire(import.meta.url);
  try { return req('@jridgewell/trace-mapping'); } catch { /* fall through to the pnpm store */ }
  const store = join(ROOT, 'node_modules/.pnpm');
  const dirs = existsSync(store) ? readdirSync(store).filter((d) => d.startsWith('@jridgewell+trace-mapping@')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
  for (const d of dirs) {
    const p = join(store, d, 'node_modules/@jridgewell/trace-mapping');
    if (existsSync(p)) return req(p);
  }
  throw new Error('@jridgewell/trace-mapping not found (it is a dependency of jest, so `pnpm install` brings it)');
}
const tm = loadTraceMapping();

/** Repo-relative path of an original source (file:// url, absolute path, or turbopack:/// url); null when it is not a file of this repo. */
export function repoRelative(source, baseDir) {
  let p = source.replace(/^turbopack:\/\/\/\[project\]\//, ROOT + '/').replace(/^webpack:\/\/[^/]*\/(\.\/)?/, ROOT + '/packages/backend/');
  if (p.startsWith('file://')) p = decodeURIComponent(new URL(p).pathname);
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.startsWith('/')) return null;
  if (!p.startsWith('/')) p = baseDir ? resolve(baseDir, p) : join(ROOT, 'packages/backend', p.replace(/^\.\//, ''));
  p = resolve(p);
  if (!p.startsWith(ROOT + '/') || p.includes('/node_modules/')) return null;
  return p.slice(ROOT.length + 1);
}

/** Line start offsets of a text, to turn a V8 character offset into a line and column. */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}
function position(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return { line: lo + 1, column: offset - starts[lo] };
}

/**
 * @param {{ source: string, functions: Array<{functionName: string, ranges: Array<{startOffset:number,endOffset:number,count:number}>}>, mapJson?: object|string }} script
 * @returns {Array<{file:string,line:number,col:number,name:string,count:number}>} one entry per function that maps to a file of the repo
 */
export function functionsOfScript({ source, functions, mapJson, baseDir }) {
  if (!mapJson) return [];
  const map = mapJson.sections ? new tm.FlattenMap(mapJson) : new tm.TraceMap(mapJson);
  const starts = lineStarts(source);
  const out = new Map();
  for (const fn of functions) {
    const r = fn.ranges[0];
    const at = position(starts, r.startOffset);
    const o = tm.originalPositionFor(map, { line: at.line, column: at.column });
    if (!o || !o.source || o.line == null) continue;
    const file = repoRelative(o.source, baseDir);
    if (!file) continue;
    // the bundler's own wrapper of a whole module maps to the top of the file and has no name: not a function of the author
    if (!fn.functionName && o.line === 1 && o.column === 0) continue;
    const key = `${file}|${o.line}|${o.column}`;
    const prev = out.get(key);
    const count = r.count;
    if (!prev || count > prev.count) out.set(key, { file, line: o.line, col: o.column, name: fn.functionName || o.name || '', count });
  }
  return [...out.values()];
}

/** The source map of a script given its text and (optionally) the folder or url it was loaded from. */
export function mapOfSource(source, scriptPathOrUrl) {
  const m = /\/\/# sourceMappingURL=(\S+)\s*$/m.exec(source.slice(-2000));
  if (!m) return null;
  const ref = m[1];
  if (ref.startsWith('data:')) return JSON.parse(Buffer.from(ref.split(',')[1], ref.includes('base64') ? 'base64' : 'utf8').toString('utf8'));
  if (scriptPathOrUrl && !/^https?:/.test(scriptPathOrUrl)) {
    const p = scriptPathOrUrl.startsWith('file://') ? fileURLToPath(scriptPathOrUrl) : scriptPathOrUrl;
    const mp = join(dirname(p), decodeURIComponent(ref));
    return existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : null;
  }
  return null;
}

/** Functions of the V8 coverage files that NODE_V8_COVERAGE wrote (a folder of coverage-*.json): only scripts that are files of this repo's builds. */
export function functionsOfV8Dir(dir) {
  const result = [];
  for (const f of readdirSync(dir).filter((n) => n.startsWith('coverage-') && n.endsWith('.json'))) {
    let data;
    try { data = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    for (const s of data.result ?? []) {
      if (!s.url.startsWith('file://') || s.url.includes('/node_modules/')) continue;
      const p = fileURLToPath(s.url);
      if (!existsSync(p)) continue;
      const source = readFileSync(p, 'utf8');
      const mapJson = mapOfSource(source, p);
      if (!mapJson) continue;
      result.push(...functionsOfScript({ source, functions: s.functions, mapJson, baseDir: dirname(p) }));
    }
  }
  return result;
}
export { pathToFileURL };
