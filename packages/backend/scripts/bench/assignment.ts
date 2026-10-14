/**
 * Microbenchmark of assignment (S39 SC-004): the time to assign one caller across 100 running experiments (two hashes
 * each), no I/O, over 100,000 distinct units. An ops artifact (specs/UNVERIFIED.md): it prints the numbers and whether the
 * 5 ms p99 budget holds, it does not gate the build.
 *
 * Run: pnpm bench:assignment            (UNITS=100000 EXPERIMENTS=100 to change the sizes)
 */
import { performance } from 'node:perf_hooks';
import { assignAll } from '../../libs/domains/experimentation/domain/experiments';
import type { RunningExperiment } from '../../libs/domains/experimentation/domain/experiment-types';

const EXPERIMENTS = Number(process.env.EXPERIMENTS ?? 100);
const UNITS = Number(process.env.UNITS ?? 100_000);
const BUDGET_MS = 5;

const running: RunningExperiment[] = Array.from(
  { length: EXPERIMENTS },
  (_, i) => ({
    key: `bench-exp-${i}`,
    unit: i % 2 ? 'user' : 'visitor',
    variants: [
      { key: 'control', weight: 5_000 },
      { key: 'treatment', weight: 5_000 },
    ],
    // Every fourth experiment shares layer 0 on a disjoint slice, as a real layer would.
    layer: `bench-layer-${i % 25}`,
    layerFrom: (i % 4) * 2_500,
    layerTo: (i % 4) * 2_500 + 2_500,
  }),
);

// Warm the JIT before timing.
for (let i = 0; i < 2_000; i++)
  assignAll(running, { userId: `warm-${i}`, anonymousId: `warm-anon-${i}` });

const timings = new Float64Array(UNITS);
let assigned = 0;
for (let i = 0; i < UNITS; i++) {
  const ids = { userId: `user-${i}`, anonymousId: `anonymous-visitor-${i}` };
  const started = performance.now();
  assigned += Object.keys(assignAll(running, ids)).length;
  timings[i] = performance.now() - started;
}
const sorted = Array.from(timings).sort((a, b) => a - b);
const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

console.log(
  JSON.stringify(
    {
      experiments: EXPERIMENTS,
      units: UNITS,
      assignedPerUnit: assigned / UNITS,
      p50Ms: Number(at(0.5).toFixed(4)),
      p99Ms: Number(at(0.99).toFixed(4)),
      maxMs: Number(sorted[sorted.length - 1].toFixed(4)),
      budgetMs: BUDGET_MS,
      withinBudget: at(0.99) < BUDGET_MS,
    },
    null,
    2,
  ),
);
