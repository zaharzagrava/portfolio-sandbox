/**
 * Microbenchmark of the flag evaluator (S38 SC-001): evaluations per second per core over a 500-flag ruleset with rules
 * and rollouts, no I/O. An ops artifact (specs/UNVERIFIED.md): it prints the number, it does not gate the build.
 *
 * Run: pnpm bench:flag-evaluator            (ITERATIONS=5000000 to change the count)
 */
import {
  evaluate,
  type FlagDefinition,
} from '../libs/domains/experimentation/domain/evaluator';

const FLAGS = 500;
const ITERATIONS = Number(process.env.ITERATIONS ?? 5_000_000);

const flags: FlagDefinition[] = Array.from({ length: FLAGS }, (_, i) => ({
  key: `bench-flag-${i}`,
  status: 'enabled',
  variants: [
    { key: 'off', value: false },
    { key: 'on', value: true },
  ],
  defaultVariant: 'off',
  offVariant: 'off',
  bucketBy: 'userId',
  version: 1,
  rules: [
    {
      id: 'staff',
      conditions: [
        { attribute: 'email_domain', op: 'in', values: ['marketplace.dev'] },
      ],
      variant: 'on',
    },
    {
      id: 'countries',
      conditions: [
        { attribute: 'country', op: 'in', values: ['DE', 'FR', 'NL'] },
        { attribute: 'platform', op: 'eq', values: ['ios'] },
      ],
      variant: 'on',
    },
    {
      id: 'rollout',
      conditions: [],
      rollout: [
        { variant: 'on', weight: 2_000 },
        { variant: 'off', weight: 8_000 },
      ],
    },
  ],
}));
const byKey = new Map(flags.map((f) => [f.key, f]));
const keys = flags.map((f) => f.key);
const contexts = Array.from({ length: 1_000 }, (_, i) => ({
  userId: `user-${i}`,
  country: i % 3 === 0 ? 'DE' : 'US',
  platform: i % 2 === 0 ? 'ios' : 'web',
  email_domain: i % 50 === 0 ? 'marketplace.dev' : 'example.com',
}));

let on = 0;
// warm up
for (let i = 0; i < 200_000; i++)
  evaluate(byKey.get(keys[i % FLAGS]), contexts[i % contexts.length]);

const started = process.hrtime.bigint();
for (let i = 0; i < ITERATIONS; i++)
  if (
    evaluate(byKey.get(keys[i % FLAGS]), contexts[i % contexts.length])
      .value === true
  )
    on++;
const seconds = Number(process.hrtime.bigint() - started) / 1e9;

const perSecond = Math.round(ITERATIONS / seconds);
console.log(
  JSON.stringify({
    flags: FLAGS,
    iterations: ITERATIONS,
    seconds: Number(seconds.toFixed(3)),
    evaluationsPerSecond: perSecond,
    onShare: Number((on / ITERATIONS).toFixed(3)),
    meetsSc001: perSecond > 1_000_000,
  }),
);
