import { murmur3 } from '@app/common/core/murmur3';

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

export interface FlagDefinition {
  key: string;
  enabled: boolean;
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
  reason: 'off' | 'rule' | 'rollout' | 'default' | 'unknown_flag';
  ruleId?: string;
}

const BUCKETS = 10_000;

/** Stable bucket in [0, 10000) for (flag, unit): the same user always lands in the same bucket of a flag. */
export function bucketOf(flagKey: string, unit: string): number {
  return murmur3(`${flagKey}:${unit}`) % BUCKETS;
}

function matches(condition: Condition, ctx: EvalContext): boolean {
  const actual = ctx[condition.attribute];
  const values = condition.values ?? [];
  switch (condition.op) {
    case 'exists':
      return actual !== undefined && actual !== null && actual !== '';
    case 'in':
      return Array.isArray(actual) ? actual.some((a) => values.includes(a)) : actual !== undefined && values.includes(actual as string);
    case 'not_in':
      return Array.isArray(actual) ? !actual.some((a) => values.includes(a)) : actual === undefined || !values.includes(actual as string);
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

/**
 * Pure, allocation-light evaluation (runs millions of times per second per
 * core, never touches the network):
 *   disabled → off variant; first matching rule wins (targeted variant or
 *   weighted rollout); no rule → default variant.
 * Rollouts pick by cumulative weight over a hash bucket, so widening 5% → 20%
 * only ADDS users (bucket < 500 is also < 2000) - nobody flips back and forth.
 * Without a bucketing unit (anonymous, no userId) a rollout serves its first
 * variant (conservative: usually the control).
 */
export function evaluate(flag: FlagDefinition | undefined, ctx: EvalContext): Evaluation {
  if (!flag) return { key: '?', variant: 'off', value: false, reason: 'unknown_flag' };
  const value = (variantKey: string) => flag.variants.find((v) => v.key === variantKey)?.value ?? false;
  if (!flag.enabled) return { key: flag.key, variant: flag.offVariant, value: value(flag.offVariant), reason: 'off' };

  for (const rule of flag.rules) {
    if (!rule.conditions.every((c) => matches(c, ctx))) continue;
    if (rule.variant) return { key: flag.key, variant: rule.variant, value: value(rule.variant), reason: 'rule', ruleId: rule.id };
    if (rule.rollout?.length) {
      const unit = ctx[flag.bucketBy];
      if (typeof unit !== 'string' || !unit) return { key: flag.key, variant: rule.rollout[0].variant, value: value(rule.rollout[0].variant), reason: 'rollout', ruleId: rule.id };
      const bucket = bucketOf(flag.key, unit);
      let cumulative = 0;
      for (const slice of rule.rollout) {
        cumulative += slice.weight;
        if (bucket < cumulative) return { key: flag.key, variant: slice.variant, value: value(slice.variant), reason: 'rollout', ruleId: rule.id };
      }
    }
  }
  return { key: flag.key, variant: flag.defaultVariant, value: value(flag.defaultVariant), reason: 'default' };
}

/** Admin-side validation: weights sum to 10,000, every referenced variant exists. */
export function validateFlag(flag: Omit<FlagDefinition, 'version'>): string[] {
  const errors: string[] = [];
  const keys = new Set(flag.variants.map((v) => v.key));
  for (const k of [flag.defaultVariant, flag.offVariant]) if (!keys.has(k)) errors.push(`unknown variant ${k}`);
  for (const rule of flag.rules) {
    if (!rule.variant && !rule.rollout?.length) errors.push(`rule ${rule.id}: needs a variant or a rollout`);
    if (rule.variant && !keys.has(rule.variant)) errors.push(`rule ${rule.id}: unknown variant ${rule.variant}`);
    if (rule.rollout) {
      const sum = rule.rollout.reduce((s, r) => s + r.weight, 0);
      if (sum !== BUCKETS) errors.push(`rule ${rule.id}: rollout weights sum to ${sum}, expected ${BUCKETS}`);
      for (const r of rule.rollout) if (!keys.has(r.variant)) errors.push(`rule ${rule.id}: unknown variant ${r.variant}`);
    }
  }
  return errors;
}
