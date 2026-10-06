#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Cache } from './src/cache.ts';
import { LEVELS, loadConfig, type Level } from './src/config.ts';
import { listSourceFiles, readText } from './src/files.ts';
import { buildGraph, graphStats } from './src/graph.ts';
import { makeProvider } from './src/llm.ts';
import { buildConceptModel, capmapId } from './src/concepts.ts';
import { buildNodes, type NodeSpec } from './src/nodes.ts';
import { runPipeline, type RunReport } from './src/pipeline.ts';
import { renderAll, syncOutputs } from './src/render.ts';
import { syncNotes, theoryRefs, type Note } from './src/theory.ts';

const HELP = `docs generator: builds docs/humans from the code

usage: node scripts/docs/cli.ts <command> [options]

commands
  extract    static analysis only; prints what was found (units, routes, events, jobs, flows)
  plan       dry run: which summaries are stale and a rough input-token estimate (no LLM calls)
  generate   write stale summaries with an LLM, then render the markdown (and refresh the theory notes' link blocks)
  theory     only the theory level: link each interview-prep section to where the code implements it, then update the notes
  render     render markdown from the cached summaries (no LLM)
  check      CI gate: report stale summaries and markdown that differs from the cache (--strict to fail)

options
  --unit <name>[,<name>]   limit generation to units (name, group/name or root path); repeatable
  --level <l>[,<l>]        limit generation to levels: ${LEVELS.join(', ')}
  --provider <p>           auto (default) | anthropic | claude-cli | mock
  --model <id>             use one model for every level (cheap trial runs)
  --concurrency <n>        parallel LLM calls (default 6)
  --max-calls <n>          stop after n LLM calls (default 5000)
  --force                  regenerate selected nodes even if cached
  --json <file>            extract: also write the graph as JSON
  --strict                 check: exit 1 when anything is stale or out of sync
  --config <file>          alternative config (default scripts/docs/docs.config.json)
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    unit: { type: 'string', multiple: true },
    level: { type: 'string', multiple: true },
    provider: { type: 'string', default: 'auto' },
    model: { type: 'string' },
    concurrency: { type: 'string', default: '6' },
    'max-calls': { type: 'string', default: '5000' },
    force: { type: 'boolean', default: false },
    json: { type: 'string' },
    strict: { type: 'boolean', default: false },
    config: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const log = (m: string) => process.stderr.write(`${m}\n`);

function repoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dirname(fileURLToPath(import.meta.url)) }).toString().trim();
  } catch {
    return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  }
}

/** Hand-written theory notes: markdown under cfg.theory.dir, minus excluded paths (private folders, the index). */
function loadNotes(root: string, cfg: ReturnType<typeof loadConfig>): Note[] {
  const base = cfg.theory.dir;
  const out: Note[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      if (name.startsWith('.')) continue;
      const r = `${rel}/${name}`;
      const inner = r.slice(base.length + 1);
      if (cfg.theory.exclude.some((x) => inner === x || inner.startsWith(`${x}/`))) continue;
      if (statSync(join(root, r)).isDirectory()) walk(r);
      else if (name.endsWith('.md')) out.push({ path: r, text: readFileSync(join(root, r), 'utf8') });
    }
  };
  if (existsSync(join(root, base))) walk(base);
  return out;
}

function setup() {
  const root = repoRoot();
  const cfg = loadConfig(root, values.config ? resolve(values.config) : undefined);
  const files = listSourceFiles(root, cfg);
  const graph = buildGraph(cfg, files, (p) => readText(root, p), root);
  const sources = new Map<string, string>();
  const notes = loadNotes(root, cfg);
  const source = buildNodes({
    cfg,
    graph,
    readSource: (p) => sources.get(p) ?? (sources.set(p, readText(root, p)), sources.get(p)!),
    readContext: (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null),
    notes,
    patternMap: existsSync(join(root, cfg.theory.patternMap)) ? readFileSync(join(root, cfg.theory.patternMap), 'utf8') : null,
  });
  const cache = new Cache(join(root, cfg.outDir, '.cache'));
  return { root, cfg, graph, source, cache, notes };
}

function selector(graph: ReturnType<typeof setup>['graph']): (s: NodeSpec) => boolean {
  const tokens = (values.unit ?? []).flatMap((u) => u.split(',')).map((s) => s.trim()).filter(Boolean);
  const levels = new Set((values.level ?? []).flatMap((l) => l.split(',')).map((s) => s.trim()).filter(Boolean));
  for (const l of levels) if (!LEVELS.includes(l as Level)) throw new Error(`unknown level "${l}" (${LEVELS.join(', ')})`);
  const unitIds = new Set<string>();
  for (const t of tokens) {
    const hits = graph.units.filter((u) => u.id === t || u.label === t || u.name === t);
    if (!hits.length) throw new Error(`no unit matches "${t}"; try \`extract\` to list them`);
    for (const h of hits) unitIds.add(h.id);
  }
  return (s) => (!levels.size || levels.has(s.level)) && (!tokens.length || s.unitIds.some((id) => unitIds.has(id)));
}

const baseOpts = (select: (s: NodeSpec) => boolean, dryRun: boolean) => ({
  select,
  dryRun,
  force: values.force,
  concurrency: Math.max(1, Number(values.concurrency)),
  maxCalls: Number(values['max-calls']),
  modelOverride: values.model,
  log,
});

function summarize(report: RunReport): { stale: number; failed: number } {
  const bad = (s: string) => report.results.filter((r) => r.status === s);
  const warnings = report.results.flatMap((r) => r.warnings.map((w) => `${r.id}: ${w}`));
  if (warnings.length) log(`\n${warnings.length} model claims were dropped because they did not check out against the code:\n  ${warnings.slice(0, 15).join('\n  ')}${warnings.length > 15 ? '\n  ...' : ''}`);
  for (const r of bad('failed')) log(`FAILED ${r.id}: ${r.error}`);
  return { stale: report.results.filter((r) => ['stale', 'blocked', 'over-budget', 'would-generate'].includes(r.status)).length, failed: bad('failed').length };
}

async function main(): Promise<number> {
  const cmd = positionals[0];
  if (!cmd || values.help || cmd === 'help') {
    process.stdout.write(HELP);
    return cmd || values.help ? 0 : 1;
  }
  if (!['extract', 'plan', 'generate', 'theory', 'render', 'check'].includes(cmd)) {
    log(`unknown command "${cmd}"\n\n${HELP}`);
    return 1;
  }
  const { root, cfg, graph, source, cache, notes } = setup();

  /** Refreshes the generated blocks in the notes (only notes that have theory output; hand-written text is untouched). */
  const syncTheory = (outputs: Map<string, any>, apply: boolean) => {
    const have = notes.filter((n) => outputs.has(`theory:${n.path}`));
    if (!have.length) return { changed: [] as string[], unchanged: 0 };
    const model = buildConceptModel(graph, outputs, { maxUses: cfg.maxConceptUses, maxDepth: cfg.maxConceptDepth, maxPerUnit: cfg.maxConceptsPerUnit });
    return syncNotes(have, (path, text) => apply && writeFileSync(join(root, path), text), theoryRefs(outputs, model, graph.files), model, outputs, cfg.outDir);
  };

  if (cmd === 'extract') {
    console.log(JSON.stringify(graphStats(graph), null, 2));
    console.log(`\nunits (${graph.units.length}):\n${graph.units.map((u) => `  ${u.label.padEnd(40)} ${String(u.files.length).padStart(4)} files, ${u.modules.length} modules`).join('\n')}`);
    console.log(`\nflows (${graph.flows.length}):\n${graph.flows.map((f) => `  ${f.slug.padEnd(40)} ${f.files.length} files, ${f.edges.length} hops`).join('\n')}`);
    if (graph.warnings.length) console.log(`\nwarnings:\n  ${graph.warnings.join('\n  ')}`);
    if (values.json) {
      writeFileSync(resolve(values.json), `${JSON.stringify({ stats: graphStats(graph), units: graph.units, unitEdges: graph.unitEdges, events: graph.events, jobs: graph.jobs, flows: graph.flows }, null, 1)}\n`);
      log(`wrote ${values.json}`);
    }
    return 0;
  }

  if (cmd === 'theory') values.level = ['theory'];
  const select = selector(graph);

  if (cmd === 'plan') {
    const report = await runPipeline(source, cache, { ...baseOpts(select, true), provider: makeProvider('mock') });
    const { stale } = summarize(report);
    const need = report.results.filter((r) => r.status === 'would-generate').length;
    log(`\n${need} nodes need an LLM call (${stale - need} more are stale but outside the selection or blocked).`);
    log(`Rough input size: ~${(report.estimatedInputTokens / 1e6).toFixed(2)}M tokens (a lower bound: dependent levels are estimated before their inputs exist).`);
    const unmapped = graph.units.filter((u) => select({ unitIds: [u.id] } as NodeSpec) && !report.outputs.has(capmapId(u)));
    if (unmapped.length) {
      const pages = unmapped.reduce((n, u) => n + Math.min(16, Math.max(1, Math.ceil(u.files.length / 3))), 0);
      log(`Concept pages are planned only after a unit's capability map exists: ${unmapped.length} units still need one, which will add roughly ${pages} top-level concept calls. Sub-topics are discovered while pages are written, typically a few times that many (bounded by maxConceptDepth / maxConceptsPerUnit).`);
    }
    return 0;
  }

  if (cmd === 'generate' || cmd === 'theory') {
    const provider = makeProvider(values.provider!);
    log(`provider: ${provider.name}${values.model ? `, model override: ${values.model}` : ''}`);
    const report = await runPipeline(source, cache, { ...baseOpts(select, false), provider });
    const { failed } = summarize(report);
    const filtered = (values.unit?.length ?? 0) > 0 || (values.level?.length ?? 0) > 0;
    if (!filtered && !failed) {
      let pruned = 0;
      for (const level of LEVELS) pruned += cache.prune(level, new Set(report.specs.filter((s) => s.level === level).map((s) => s.id)));
      cache.save();
      if (pruned) log(`pruned ${pruned} cache entries for code that no longer exists`);
    }
    log(`\n${report.calls} LLM calls, ~${report.inputTokens} input / ${report.outputTokens} output tokens`);
    const rep = syncOutputs(root, cfg.outDir, renderAll(cfg, graph, report.outputs, report.stale), true);
    log(`rendered ${cfg.outDir}: ${rep.written.length} written, ${rep.removed.length} removed, ${rep.unchanged} unchanged`);
    const th = syncTheory(report.outputs, true);
    if (th.changed.length || th.unchanged) log(`theory notes: ${th.changed.length} updated, ${th.unchanged} unchanged`);
    return failed ? 1 : 0;
  }

  // render / check: no LLM, cache only
  const report = await runPipeline(source, cache, { ...baseOpts(() => false, true), provider: makeProvider('mock'), log: () => {} });
  const pages = renderAll(cfg, graph, report.outputs, report.stale);
  if (cmd === 'render') {
    const rep = syncOutputs(root, cfg.outDir, pages, true);
    log(`rendered ${cfg.outDir}: ${rep.written.length} written, ${rep.removed.length} removed, ${rep.unchanged} unchanged`);
    const th = syncTheory(report.outputs, true);
    if (th.changed.length || th.unchanged) log(`theory notes: ${th.changed.length} updated, ${th.unchanged} unchanged`);
    return 0;
  }

  // check
  const pending = report.results.filter((r) => ['stale', 'blocked'].includes(r.status));
  const byLevel = LEVELS.map((l) => `${l}: ${pending.filter((r) => r.level === l).length}`).join(', ');
  const rep = syncOutputs(root, cfg.outDir, pages, false);
  const drift = rep.written.length + rep.removed.length;
  log(pending.length ? `${pending.length} summaries are stale or missing (${byLevel}). Run \`pnpm docs:generate\`.` : 'all summaries are up to date');
  if (pending.length) log(`  e.g. ${pending.slice(0, 8).map((r) => r.id).join('\n       ')}`);
  log(drift ? `${drift} generated pages differ from what the cache renders (${[...rep.written, ...rep.removed].slice(0, 5).join(', ')}). Run \`pnpm docs:render\`.` : 'generated pages match the cache');
  const th = syncTheory(report.outputs, false);
  if (th.changed.length) log(`${th.changed.length} theory notes differ from what the cache renders (${th.changed.slice(0, 5).join(', ')}). Run \`pnpm docs:render\`.`);
  return values.strict && (pending.length || drift || th.changed.length) ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
