import type { DocsConfig, UnitRule } from './config.ts';
import { extractFile, type FileFacts, type RouteInfo } from './extract.ts';
import { Resolver } from './resolve.ts';
import { bySort, slugify, uniq } from './util.ts';

export interface Unit {
  id: string; // repo-relative root path
  name: string;
  group: string;
  label: string; // `group/name`
  files: string[];
  modules: Module[];
}
export interface Module { id: string; unitId: string; name: string; files: string[] }
export interface ImportEdge { from: string; to: string; kind: string; typeOnly: boolean }
export interface EventInfo { const: string; name: string; aggregate: string; definedIn: string; line: number; producers: string[]; consumers: string[] }
export interface JobInfo { name: string; handlers: { file: string; handler: string; line: number }[]; enqueuers: string[]; schedules: { file: string; cron: string }[] }
export interface AsyncEdge { from: string; to: string; via: 'event' | 'job'; name: string }
export interface FlowInfo { id: string; slug: string; files: string[]; edges: AsyncEdge[]; units: string[]; entrypoints: (RouteInfo & { file: string })[] }
export interface UnitEdge { from: string; to: string; count: number; samples: string[] }

export interface Graph {
  files: Map<string, FileFacts>;
  units: Unit[];
  unitOfFile: Map<string, string>;
  moduleOfFile: Map<string, string>;
  edges: ImportEdge[];
  unitEdges: UnitEdge[];
  events: EventInfo[];
  jobs: JobInfo[];
  flows: FlowInfo[];
  /** file -> npm packages it imports (not resolvable inside the repo). */
  externals: Map<string, string[]>;
  warnings: string[];
}

function matchRule(path: string, rule: UnitRule): string | null {
  const pat = rule.match.split('/');
  const segs = path.split('/');
  if (segs.length <= pat.length) return null; // the file must live *inside* the unit root
  for (let i = 0; i < pat.length; i++) if (pat[i] !== '*' && pat[i] !== segs[i]) return null;
  return segs.slice(0, pat.length).join('/');
}

function assignUnit(path: string, rules: UnitRule[]): { root: string; rule: UnitRule } {
  for (const rule of rules) {
    const root = matchRule(path, rule);
    if (root) return { root, rule };
  }
  const segs = path.split('/');
  const root = segs.length > 1 ? segs[0] : '.';
  return { root, rule: { match: root, group: 'other' } };
}

export function buildGraph(cfg: DocsConfig, filePaths: string[], read: (p: string) => string, root: string): Graph {
  const warnings: string[] = [];
  const files = new Map<string, FileFacts>();
  for (const p of filePaths) files.set(p, extractFile(p, read(p), cfg));

  // --- units & modules
  const unitMap = new Map<string, Unit>();
  const unitOfFile = new Map<string, string>();
  const moduleOfFile = new Map<string, string>();
  const moduleMap = new Map<string, Module>();
  for (const p of filePaths) {
    const { root: unitRoot, rule } = assignUnit(p, cfg.units);
    let unit = unitMap.get(unitRoot);
    if (!unit) {
      const name = unitRoot.split('/').pop() ?? unitRoot;
      unit = { id: unitRoot, name, group: rule.group, label: `${rule.group}/${name}`, files: [], modules: [] };
      unitMap.set(unitRoot, unit);
    }
    unit.files.push(p);
    unitOfFile.set(p, unitRoot);
    const rel = p.slice(unitRoot.length + 1).split('/');
    const depth = rule.moduleDepth ?? 1;
    const dirs = rel.slice(0, -1).slice(0, depth);
    const modName = dirs.length ? dirs.join('/') : '(root)';
    const modId = `${unitRoot}::${modName}`;
    let mod = moduleMap.get(modId);
    if (!mod) {
      mod = { id: modId, unitId: unitRoot, name: modName, files: [] };
      moduleMap.set(modId, mod);
      unit.modules.push(mod);
    }
    mod.files.push(p);
    moduleOfFile.set(p, modId);
  }
  // Two units could collide on label (e.g. same group + dir name): disambiguate with the path.
  const labels = new Map<string, Unit[]>();
  for (const u of unitMap.values()) labels.set(u.label, [...(labels.get(u.label) ?? []), u]);
  for (const group of labels.values()) if (group.length > 1) for (const u of group) u.label = `${u.group}/${u.id}`;
  const units = bySort([...unitMap.values()], (u) => u.label);
  for (const u of units) {
    u.files.sort();
    u.modules.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  // --- import edges
  const resolver = new Resolver(root, new Set(filePaths));
  const edges: ImportEdge[] = [];
  const externals = new Map<string, string[]>();
  for (const f of files.values()) {
    const ext: string[] = [];
    for (const imp of f.imports) {
      const to = resolver.resolve(f.path, imp.spec);
      if (to && to !== f.path) edges.push({ from: f.path, to, kind: imp.kind, typeOnly: imp.typeOnly });
      else if (!to && !imp.typeOnly) {
        const pkg = packageName(imp.spec);
        if (pkg) ext.push(pkg);
      }
    }
    if (ext.length) externals.set(f.path, uniq(ext).sort());
  }
  const ue = new Map<string, UnitEdge>();
  for (const e of edges) {
    const a = unitOfFile.get(e.from)!;
    const b = unitOfFile.get(e.to)!;
    if (a === b) continue;
    const key = `${a}->${b}`;
    const cur = ue.get(key) ?? { from: a, to: b, count: 0, samples: [] };
    cur.count++;
    if (cur.samples.length < 3) cur.samples.push(e.from);
    ue.set(key, cur);
  }
  const unitEdges = bySort([...ue.values()], (e) => `${e.from}->${e.to}`);

  // --- events
  const defsByConst = new Map<string, { file: string; def: FileFacts['eventDefs'][number] }[]>();
  for (const f of files.values()) for (const d of f.eventDefs) defsByConst.set(d.const, [...(defsByConst.get(d.const) ?? []), { file: f.path, def: d }]);
  const events: EventInfo[] = [];
  for (const [c, defs] of defsByConst) {
    if (defs.length > 1) {
      warnings.push(`event constant "${c}" is defined in ${defs.length} files; skipping producer/consumer linking for it`);
      continue;
    }
    const { file, def } = defs[0];
    const producers = [...files.values()].filter((f) => f.createCalls.includes(c) && f.path !== file).map((f) => f.path);
    const consumers = [...files.values()].filter((f) => f.matchCalls.includes(c) && f.path !== file).map((f) => f.path);
    events.push({ const: c, name: def.name, aggregate: def.aggregate, definedIn: file, line: def.line, producers: producers.sort(), consumers: consumers.sort() });
  }
  events.sort((a, b) => (a.name < b.name ? -1 : 1));

  // --- jobs
  const jobMap = new Map<string, JobInfo>();
  const job = (name: string) => jobMap.get(name) ?? (jobMap.set(name, { name, handlers: [], enqueuers: [], schedules: [] }), jobMap.get(name)!);
  for (const f of files.values()) {
    for (const h of f.jobHandlers) job(h.name).handlers.push({ file: f.path, handler: h.handler, line: h.line });
    for (const n of f.jobsEnqueued) job(n).enqueuers.push(f.path);
    for (const s of f.schedules) job(s.job).schedules.push({ file: f.path, cron: s.cron });
  }
  const jobs = bySort([...jobMap.values()], (j) => j.name);
  for (const j of jobs) j.enqueuers = uniq(j.enqueuers).sort();

  // --- flows = connected components of the async (event/job) file graph
  const asyncEdges: AsyncEdge[] = [];
  for (const ev of events) for (const p of ev.producers) for (const c of ev.consumers) if (p !== c) asyncEdges.push({ from: p, to: c, via: 'event', name: ev.name });
  for (const j of jobs) for (const e of j.enqueuers) for (const h of j.handlers) if (e !== h.file) asyncEdges.push({ from: e, to: h.file, via: 'job', name: j.name });
  const flows = buildFlows(asyncEdges, files, edges, unitOfFile, units);

  return { files, units, unitOfFile, moduleOfFile, edges, unitEdges, events, jobs, flows, externals, warnings };
}

const NODE_BUILTINS = new Set(['fs', 'path', 'crypto', 'os', 'util', 'http', 'https', 'stream', 'events', 'child_process', 'url', 'zlib', 'net', 'buffer', 'assert', 'readline', 'timers', 'worker_threads', 'tls', 'dns', 'querystring', 'cluster', 'perf_hooks', 'process', 'module', 'v8', 'vm']);

/** `@scope/pkg/sub` -> `@scope/pkg`; relative paths and node built-ins -> null. */
function packageName(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  const segs = spec.split('/');
  const name = spec.startsWith('@') ? segs.slice(0, 2).join('/') : segs[0];
  return NODE_BUILTINS.has(name) ? null : name;
}

const ENTRY_HOPS = 2;

function buildFlows(asyncEdges: AsyncEdge[], files: Map<string, FileFacts>, edges: ImportEdge[], unitOfFile: Map<string, string>, units: Unit[]): FlowInfo[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    const p = parent.get(x)!;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  for (const e of asyncEdges) parent.set(find(e.from), find(e.to));
  const comps = new Map<string, string[]>();
  for (const f of parent.keys()) comps.set(find(f), [...(comps.get(find(f)) ?? []), f]);

  const importedBy = new Map<string, string[]>();
  for (const e of edges) importedBy.set(e.to, [...(importedBy.get(e.to) ?? []), e.from]);
  const labelOf = new Map(units.map((u) => [u.id, u.label]));

  const used = new Set<string>();
  const flows: FlowInfo[] = [];
  for (const members of comps.values()) {
    const fileList = members.sort();
    const set = new Set(fileList);
    const compEdges = bySort(asyncEdges.filter((e) => set.has(e.from) && set.has(e.to)), (e) => `${e.name}|${e.from}|${e.to}`);
    const names = uniq(compEdges.map((e) => e.name)).sort();
    let slug = slugify(names[0] ?? fileList[0]);
    for (let n = 2; used.has(slug); n++) slug = `${slugify(names[0])}-${n}`;
    used.add(slug);

    // entrypoints: route-bearing files that (transitively, <=4 hops) import a flow member
    const seen = new Set(fileList);
    let frontier = fileList;
    const eps: (RouteInfo & { file: string })[] = [];
    for (let depth = 0; depth < ENTRY_HOPS; depth++) {
      const next: string[] = [];
      for (const f of frontier) for (const imp of importedBy.get(f) ?? []) if (!seen.has(imp)) (seen.add(imp), next.push(imp));
      frontier = next;
    }
    for (const f of [...seen].sort()) for (const r of files.get(f)?.routes ?? []) if (r.kind === 'http' || r.kind === 'graphql') eps.push({ ...r, file: f });

    flows.push({
      id: `flow:${slug}`,
      slug,
      files: fileList,
      edges: compEdges,
      units: uniq(fileList.map((f) => labelOf.get(unitOfFile.get(f)!)!)).sort(),
      entrypoints: eps.slice(0, 12),
    });
  }
  return bySort(flows, (f) => f.slug);
}

export function graphStats(g: Graph): Record<string, number> {
  return {
    files: g.files.size,
    units: g.units.length,
    modules: g.units.reduce((n, u) => n + u.modules.length, 0),
    importEdges: g.edges.length,
    unitEdges: g.unitEdges.length,
    routes: [...g.files.values()].reduce((n, f) => n + f.routes.length, 0),
    events: g.events.length,
    jobs: g.jobs.length,
    flows: g.flows.length,
    trivialFiles: [...g.files.values()].filter((f) => f.isTrivial).length,
  };
}
