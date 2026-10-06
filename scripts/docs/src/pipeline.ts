import { LEVELS, type Level } from './config.ts';
import { Cache } from './cache.ts';
import { extractJson, estimateTokens, type Provider } from './llm.ts';
import { nodeFingerprint, type NodeSource, type NodeSpec, type Outputs } from './nodes.ts';
import { mapPool } from './util.ts';

export type Status = 'cached' | 'static' | 'generated' | 'would-generate' | 'stale' | 'blocked' | 'failed' | 'over-budget';

export interface NodeResult { id: string; level: Level; status: Status; error?: string; warnings: string[] }
export interface RunOptions {
  provider: Provider;
  /** Which stale nodes to (re)generate. Nodes that fail the filter stay stale. */
  select: (spec: NodeSpec) => boolean;
  dryRun: boolean;
  force: boolean;
  concurrency: number;
  maxCalls: number;
  /** Overrides every level's model (handy for cheap trial runs). */
  modelOverride?: string;
  log: (msg: string) => void;
}
export interface RunReport {
  results: NodeResult[];
  /** Every spec that took part (concept and unit specs only exist once the capability maps do). */
  specs: NodeSpec[];
  /** id -> output (possibly stale) for everything that has one. */
  outputs: Outputs;
  stale: Set<string>;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedInputTokens: number;
}

const ORDER = (l: Level) => LEVELS.indexOf(l);
const MAX_ROUNDS = 12;

/** Groups specs into waves so that a spec runs after the same-level specs it depends on (concepts form a DAG). */
function waves(specs: NodeSpec[]): NodeSpec[][] {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const depth = new Map<string, number>();
  const of = (s: NodeSpec, path: Set<string>): number => {
    const known = depth.get(s.id);
    if (known !== undefined) return known;
    path.add(s.id);
    let d = 0;
    for (const id of s.deps) {
      const dep = byId.get(id);
      if (dep && !path.has(id)) d = Math.max(d, of(dep, path) + 1);
    }
    path.delete(s.id);
    depth.set(s.id, d);
    return d;
  };
  const out: NodeSpec[][] = [];
  for (const s of specs) (out[of(s, new Set())] ??= []).push(s);
  return out.filter(Boolean);
}

/** `--unit` selects roots; whatever they are built on (same level) has to be generated too or they would stay blocked. */
function withDependencies(specs: NodeSpec[], select: (s: NodeSpec) => boolean): Set<string> {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const chosen = new Set<string>();
  const stack = specs.filter(select).map((s) => s.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (chosen.has(id)) continue;
    chosen.add(id);
    for (const d of byId.get(id)?.deps ?? []) if (byId.has(d)) stack.push(d);
  }
  return chosen;
}

export async function runPipeline(source: NodeSource, cache: Cache, opts: RunOptions): Promise<RunReport> {
  const outputs: Outputs = new Map();
  const stale = new Set<string>();
  const results: NodeResult[] = [];
  const report: RunReport = { results, specs: [], outputs, stale, calls: 0, inputTokens: 0, outputTokens: 0, estimatedInputTokens: 0 };

  for (const level of LEVELS) {
    // Some levels discover their own nodes (a concept page names sub-topics): ask again until nothing new shows up.
    const handled = new Set<string>();
    const before = results.length;
    for (let round = 0; round < MAX_ROUNDS; round++) {
    const levelSpecs = source(level, outputs).filter((s) => !handled.has(s.id)).sort((a, b) => ORDER(a.level) - ORDER(b.level) || (a.id < b.id ? -1 : 1));
    if (!levelSpecs.length) break;
    for (const s of levelSpecs) handled.add(s.id);
    report.specs.push(...levelSpecs);
    const chosen = withDependencies(levelSpecs, opts.select);
    const select = (s: NodeSpec) => chosen.has(s.id);

    for (const wave of waves(levelSpecs)) await mapPool(wave, opts.concurrency, async (spec) => {
      const res: NodeResult = { id: spec.id, level, status: 'cached', warnings: [] };
      results.push(res);
      const depOut: Outputs = new Map();
      let depStale = false;
      let depMissing = false;
      for (const d of spec.deps) {
        if (outputs.has(d)) {
          depOut.set(d, outputs.get(d));
          if (stale.has(d)) depStale = true;
        } else depMissing = true;
      }
      const old = cache.get(level, spec.id);
      const prior = old?.out;
      const keepOld = () => {
        if (old) {
          outputs.set(spec.id, old.out);
          stale.add(spec.id);
        }
      };

      if (depMissing && spec.trivial && opts.dryRun) {
        res.status = 'static'; // resolves from its dependencies without an LLM call once they exist
        keepOld();
        return;
      }
      if (depMissing) {
        // A dependency has no output at all (never generated, or failed): nothing to build on.
        res.status = opts.dryRun && select(spec) ? 'would-generate' : 'blocked';
        if (res.status === 'would-generate') report.estimatedInputTokens += spec.estimateIn();
        keepOld();
        return;
      }

      const triv = spec.trivial?.(depOut);
      if (triv !== undefined && !depMissing) {
        outputs.set(spec.id, triv);
        const fp = nodeFingerprint(spec, depOut);
        if (old?.fp !== fp || JSON.stringify(old?.out) !== JSON.stringify(triv)) cache.set(level, spec.id, { fp, model: 'static', out: triv });
        res.status = 'static';
        if (depStale) stale.add(spec.id);
        return;
      }

      const fp = nodeFingerprint(spec, depOut);
      if (!opts.force && old && old.fp === fp && !depStale) {
        outputs.set(spec.id, old.out);
        res.status = 'cached';
        return;
      }
      if (!select(spec)) {
        res.status = 'stale';
        keepOld();
        return;
      }
      if (opts.dryRun) {
        res.status = 'would-generate';
        report.estimatedInputTokens += estimateTokens(spec.buildPrompt(depOut, prior).prompt) + 200;
        keepOld();
        return;
      }
      if (report.calls >= opts.maxCalls) {
        res.status = 'over-budget';
        keepOld();
        return;
      }
      report.calls++;
      const model = opts.modelOverride ?? spec.model;
      try {
        const { out, warnings } = await generate(spec, depOut, model, opts.provider, report, prior);
        res.warnings = warnings;
        outputs.set(spec.id, out);
        stale.delete(spec.id);
        cache.set(level, spec.id, { fp, model, out });
        res.status = 'generated';
      } catch (e) {
        res.status = 'failed';
        res.error = e instanceof Error ? e.message : String(e);
        keepOld();
      }
      if (report.calls % 25 === 0) opts.log(`  ${report.calls} LLM calls so far`);
    });

    }
    if (!handled.size) continue;

    const mine = results.slice(before);
    const count = (st: Status) => mine.filter((r) => r.status === st).length;
    opts.log(
      `${level.padEnd(7)} ${String(handled.size).padStart(5)} nodes: ${count('cached')} cached, ${count('static')} static, ${count('generated')} generated` +
        (count('would-generate') ? `, ${count('would-generate')} would generate` : '') +
        (count('stale') ? `, ${count('stale')} stale` : '') +
        (count('blocked') ? `, ${count('blocked')} blocked` : '') +
        (count('over-budget') ? `, ${count('over-budget')} over budget` : '') +
        (count('failed') ? `, ${count('failed')} FAILED` : ''),
    );
    if (!opts.dryRun) cache.save();
  }
  return report;
}

async function generate(spec: NodeSpec, deps: Outputs, model: string, provider: Provider, report: RunReport, prior?: any): Promise<{ out: any; warnings: string[] }> {
  const p = spec.buildPrompt(deps, prior);
  let prompt = p.prompt;
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await provider.complete({ model, system: p.system, prompt, maxTokens: p.maxTokens, fake: () => spec.fake(deps) });
    report.inputTokens += res.inputTokens;
    report.outputTokens += res.outputTokens;
    try {
      return spec.parse(extractJson(res.text), deps);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      prompt = `${p.prompt}\n\nYour previous reply was rejected: ${lastErr}. Reply again with only the JSON object.`;
    }
  }
  throw new Error(`invalid model output after retry: ${lastErr}`);
}
