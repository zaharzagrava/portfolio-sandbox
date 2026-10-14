import { bucketOf } from './bucket';

export { bucketOf };

export type FlagValue = boolean | string | number | Record<string, unknown>;

export interface Variant {
  key: string;
  value: FlagValue;
}

export interface Condition {
  attribute: string;
  op: 'in' | 'not_in' | 'eq' | 'neq' | 'gte' | 'lte' | 'exists';
  values?: (string | number | boolean)[];
}

/** A rule matches when ALL its conditions hold; it then serves one variant or a weighted rollout. */
export interface Rule {
  id: string;
  conditions: Condition[];
  variant?: string;
  /** Weights in basis points (sum 10,000). */
  rollout?: { variant: string; weight: number }[];
}

/** A flag as the ruleset holds it: archived flags are not in it. */
export interface FlagDefinition {
  key: string;
  status: 'enabled' | 'disabled' | 'killed';
  variants: Variant[];
  defaultVariant: string;
  offVariant: string;
  rules: Rule[];
  bucketBy: string;
  version: number;
}

export interface EvalContext {
  userId?: string;
  shopId?: string;
  [attribute: string]: string | number | boolean | string[] | undefined;
}

export interface Evaluation {
  key: string;
  variant: string;
  value: FlagValue;
  reason:
    | 'off'
    | 'killed'
    | 'rule'
    | 'rollout'
    | 'default'
    | 'unknown_flag'
    | 'ruleset_unavailable';
  ruleId?: string;
  flagVersion: number;
}

function matches(condition: Condition, ctx: EvalContext): boolean {
  const actual = ctx[condition.attribute];
  const values = condition.values ?? [];
  switch (condition.op) {
    case 'exists':
      return actual !== undefined && actual !== null && actual !== '';
    case 'in':
      return Array.isArray(actual)
        ? actual.some((a) => values.includes(a))
        : actual !== undefined && values.includes(actual);
    case 'not_in':
      return Array.isArray(actual)
        ? !actual.some((a) => values.includes(a))
        : actual === undefined || !values.includes(actual);
    case 'eq':
      return actual === values[0];
    case 'neq':
      return actual !== values[0];
    case 'gte':
      return typeof actual === 'number' && actual >= Number(values[0]);
    case 'lte':
      return typeof actual === 'number' && actual <= Number(values[0]);
  }
}

/** The answer for a key that is not in the ruleset (unknown or archived): never an error (FR-025). */
export const unknownFlag = (key: string): Evaluation => ({
  key,
  variant: 'off',
  value: false,
  reason: 'unknown_flag',
  flagVersion: 0,
});

/** The answer before any ruleset has ever been loaded (FR-025). */
export const rulesetUnavailable = (key: string): Evaluation => ({
  key,
  variant: 'off',
  value: false,
  reason: 'ruleset_unavailable',
  flagVersion: 0,
});

/**
 * Pure, allocation-light evaluation (no clock, no I/O, no randomness; runs millions of times per second per core):
 *   killed → off variant (reason `killed`); disabled → off variant (reason `off`); first matching rule wins
 *   (targeted variant or weighted rollout); no rule → default variant.
 * Rollouts pick by cumulative weight over a hash bucket, so widening 5% → 20% only ADDS users (bucket < 500 is also
 * < 2000) - nobody flips back and forth. Without a bucketing unit a rollout serves its first slice (usually the control).
 */
export function evaluate(
  flag: FlagDefinition | undefined,
  ctx: EvalContext,
  askedKey = '?',
): Evaluation {
  if (!flag) return unknownFlag(askedKey);
  const flagVersion = flag.version;
  const value = (variantKey: string) =>
    flag.variants.find((v) => v.key === variantKey)?.value ?? false;
  const served = (
    variant: string,
    reason: Evaluation['reason'],
    ruleId?: string,
  ): Evaluation => ({
    key: flag.key,
    variant,
    value: value(variant),
    reason,
    ...(ruleId !== undefined && { ruleId }),
    flagVersion,
  });
  if (flag.status === 'killed') return served(flag.offVariant, 'killed');
  if (flag.status !== 'enabled') return served(flag.offVariant, 'off');

  for (const rule of flag.rules) {
    if (!rule.conditions.every((c) => matches(c, ctx))) continue;
    if (rule.variant) return served(rule.variant, 'rule', rule.id);
    if (rule.rollout?.length) {
      const unit = ctx[flag.bucketBy];
      if (typeof unit !== 'string' || !unit)
        return served(rule.rollout[0].variant, 'rollout', rule.id);
      const bucket = bucketOf(flag.key, unit);
      let cumulative = 0;
      for (const slice of rule.rollout) {
        cumulative += slice.weight;
        if (bucket < cumulative)
          return served(slice.variant, 'rollout', rule.id);
      }
    }
  }
  return served(flag.defaultVariant, 'default');
}
