import {
  FLAG_ATTRIBUTES,
  FLAG_BUCKET_BY,
  FLAG_KEY_PATTERN,
  FLAG_LIMITS,
  FLAG_OPERATORS,
  FLAG_RULE_ID_PATTERN,
  FLAG_VARIANT_KEY_PATTERN,
} from '@marketplace-sandbox/contracts';
import type { DefinitionProblem } from './flag-errors';

/** The semantic shape of a saved definition: what the request body says after the shape check (`flagInputSchema`). */
export interface DefinitionInput {
  description?: string;
  owner: string;
  enabled: boolean;
  variants: { key: string; value: unknown }[];
  defaultVariant: string;
  offVariant: string;
  rules: {
    id: string;
    conditions: {
      attribute: string;
      op: string;
      values?: (string | number | boolean)[];
    }[];
    variant?: string;
    rollout?: { variant: string; weight: number }[];
  }[];
  bucketBy?: string;
  clientSide?: boolean;
  expiresAt?: string | null;
}

export interface ValidationContext {
  now: Date;
  /** `expiresAt` of the stored flag; an unchanged expiry may be in the past (expiry never changes evaluation). */
  currentExpiresAt?: string | null;
}

const ARITY_ONE = new Set(['eq', 'neq', 'gte', 'lte']);
const NUMERIC = new Set(['gte', 'lte']);
const MULTI = new Set(['in', 'not_in']);

const isoOf = (value: string): string | null => {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/**
 * Every semantic problem of one definition, in one list (FR-005, FR-006): unknown references, weights, limits, formats.
 * Pure: the clock arrives as `now`. Never throws; an empty list means the definition may be stored.
 */
export function validateDefinition(
  key: string,
  input: DefinitionInput,
  ctx: ValidationContext,
): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  const add = (path: string, code: DefinitionProblem['code'], sum?: number) =>
    problems.push(sum === undefined ? { path, code } : { path, code, sum });

  if (!FLAG_KEY_PATTERN.test(key)) add('key', 'invalid_key');
  if ((input.description ?? '').length > FLAG_LIMITS.description)
    add('description', 'description_too_long');
  if (input.owner.length === 0) add('owner', 'owner_missing');
  else if (input.owner.length > FLAG_LIMITS.owner)
    add('owner', 'owner_too_long');
  if (
    input.bucketBy !== undefined &&
    !FLAG_BUCKET_BY.includes(input.bucketBy as never)
  )
    add('bucketBy', 'bucket_by_invalid');

  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    const iso = isoOf(input.expiresAt);
    if (iso === null) add('expiresAt', 'expires_at_invalid');
    else {
      const unchanged =
        ctx.currentExpiresAt != null && isoOf(ctx.currentExpiresAt) === iso;
      if (!unchanged && Date.parse(iso) <= ctx.now.getTime())
        add('expiresAt', 'expires_at_in_past');
    }
  }

  // variants
  if (input.variants.length === 0) add('variants', 'variants_missing');
  if (input.variants.length > FLAG_LIMITS.variants)
    add('variants', 'too_many_variants');
  const variantKeys = new Set<string>();
  input.variants.forEach((variant, i) => {
    if (!FLAG_VARIANT_KEY_PATTERN.test(variant.key))
      add(`variants[${i}].key`, 'invalid_variant_key');
    else if (variantKeys.has(variant.key))
      add(`variants[${i}].key`, 'duplicate_variant_key');
    variantKeys.add(variant.key);
    if (
      Buffer.byteLength(JSON.stringify(variant.value ?? null), 'utf8') >
      FLAG_LIMITS.valueBytes
    )
      add(`variants[${i}].value`, 'value_too_large');
  });
  for (const field of ['defaultVariant', 'offVariant'] as const)
    if (!variantKeys.has(input[field])) add(field, 'unknown_variant');

  // rules
  if (input.rules.length > FLAG_LIMITS.rules) add('rules', 'too_many_rules');
  const ruleIds = new Set<string>();
  input.rules.forEach((rule, i) => {
    const at = `rules[${i}]`;
    if (!FLAG_RULE_ID_PATTERN.test(rule.id)) add(`${at}.id`, 'invalid_rule_id');
    else if (ruleIds.has(rule.id)) add(`${at}.id`, 'duplicate_rule_id');
    ruleIds.add(rule.id);

    if (rule.conditions.length > FLAG_LIMITS.conditions)
      add(`${at}.conditions`, 'too_many_conditions');
    rule.conditions.forEach((condition, j) => {
      const c = `${at}.conditions[${j}]`;
      if (!FLAG_ATTRIBUTES.includes(condition.attribute as never))
        add(`${c}.attribute`, 'unknown_attribute');
      const values = condition.values ?? [];
      if (!(FLAG_OPERATORS as readonly string[]).includes(condition.op)) {
        add(`${c}.op`, 'unknown_operator');
        return;
      }
      if (values.length > FLAG_LIMITS.values)
        add(`${c}.values`, 'too_many_values');
      else if (
        (ARITY_ONE.has(condition.op) && values.length !== 1) ||
        (MULTI.has(condition.op) && values.length < 1) ||
        (condition.op === 'exists' && values.length !== 0)
      )
        add(`${c}.values`, 'values_arity_invalid');
      else if (NUMERIC.has(condition.op) && typeof values[0] !== 'number')
        add(`${c}.values[0]`, 'value_type_invalid');
    });

    const hasVariant = rule.variant !== undefined;
    const hasRollout = rule.rollout !== undefined;
    if (hasVariant === hasRollout) add(at, 'rule_target_invalid');
    if (hasVariant && !variantKeys.has(rule.variant as string))
      add(`${at}.variant`, 'unknown_variant');
    if (hasRollout) {
      const slices = rule.rollout as { variant: string; weight: number }[];
      if (slices.length < 1 || slices.length > FLAG_LIMITS.rolloutSlices)
        add(`${at}.rollout`, 'rollout_size_invalid');
      const seen = new Set<string>();
      let sum = 0;
      slices.forEach((slice, k) => {
        const s = `${at}.rollout[${k}]`;
        if (!variantKeys.has(slice.variant))
          add(`${s}.variant`, 'unknown_variant');
        else if (seen.has(slice.variant))
          add(`${s}.variant`, 'duplicate_rollout_variant');
        seen.add(slice.variant);
        if (!Number.isInteger(slice.weight) || slice.weight < 0)
          add(`${s}.weight`, 'weight_invalid');
        else sum += slice.weight;
      });
      if (sum !== 10_000) add(`${at}.rollout`, 'weights_sum_invalid', sum);
    }
  });

  return problems;
}
