import {
  EXPERIMENT_BUCKETS,
  EXPERIMENT_LAYER_PATTERN,
  EXPERIMENT_LIMITS,
  EXPERIMENT_METRICS,
  EXPERIMENT_VARIANT_KEY_PATTERN,
} from '@marketplace-sandbox/contracts';
import type { DefinitionProblem, ExperimentUnit } from './experiment-types';

/** What `validateDefinition` looks at: the write body once its shape is known to be right (types, no unknown fields). */
export interface DefinitionInput {
  owner: string;
  unit?: ExperimentUnit;
  variants: { key: string; weight: number }[];
  layer: string;
  layerFrom: number;
  layerTo: number;
  metric: string;
}

const isWeight = (weight: number): boolean =>
  Number.isInteger(weight) && weight >= 1;

/**
 * The meaning of an experiment definition (S39 FR-020, FR-021, AS-32): every problem at once, each as `{path, code}`, in
 * a stable order (variants, layer, range, metric, owner). Pure; the shape of the body was already checked. A sum is only
 * judged when every weight is itself valid, since otherwise it says nothing.
 */
export function validateDefinition(def: DefinitionInput): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  const add = (path: string, code: DefinitionProblem['code']) =>
    problems.push({ path, code });

  const { variants } = def;
  if (
    variants.length < EXPERIMENT_LIMITS.minVariants ||
    variants.length > EXPERIMENT_LIMITS.variants
  )
    add('variants', 'variants_count');
  const seen = new Set<string>();
  variants.forEach((variant, i) => {
    if (!EXPERIMENT_VARIANT_KEY_PATTERN.test(variant.key))
      add(`variants[${i}].key`, 'variant_key_invalid');
    if (seen.has(variant.key))
      add(`variants[${i}].key`, 'variant_key_duplicate');
    seen.add(variant.key);
    if (!isWeight(variant.weight))
      add(`variants[${i}].weight`, 'weight_invalid');
  });
  if (
    variants.length > 0 &&
    variants.every((v) => isWeight(v.weight)) &&
    variants.reduce((sum, v) => sum + v.weight, 0) !== EXPERIMENT_BUCKETS
  )
    add('variants', 'weights_sum');

  if (!EXPERIMENT_LAYER_PATTERN.test(def.layer)) add('layer', 'layer_invalid');

  const fromOk =
    Number.isInteger(def.layerFrom) &&
    def.layerFrom >= 0 &&
    def.layerFrom < EXPERIMENT_BUCKETS;
  const toOk =
    Number.isInteger(def.layerTo) &&
    def.layerTo > 0 &&
    def.layerTo <= EXPERIMENT_BUCKETS;
  if (!fromOk) add('layerFrom', 'layer_range_invalid');
  else if (!toOk || def.layerFrom >= def.layerTo)
    add('layerTo', 'layer_range_invalid');

  if (!(EXPERIMENT_METRICS as readonly string[]).includes(def.metric))
    add('metric', 'metric_unknown');
  else if (def.metric === 'purchase' && def.unit === 'visitor')
    add('metric', 'metric_unit_mismatch');

  if (def.owner.trim().length === 0) add('owner', 'owner_required');
  return problems;
}
