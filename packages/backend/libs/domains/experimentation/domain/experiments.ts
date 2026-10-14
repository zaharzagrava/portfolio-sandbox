import { bucketOf } from './bucket';
import type { RunningExperiment } from './experiment-types';

/**
 * Two independent hashes through the one assignment hash of the domain (`bucketOf`, S38; P0811):
 *   layer bucket   = bucketOf("layer:<layer>", unit)  → whether the unit is in the experiment at all (the layer's range)
 *   variant bucket = bucketOf("exp:<key>", unit)      → which variant, by cumulative integer weight
 * Weights are integers that sum to 10,000, so there is no floating-point arithmetic and no rounding fallback: the
 * boundaries are exact. Pure: no clock, no store. Draft and stopped experiments never reach this function.
 */
export function assign(exp: RunningExperiment, unit: string): string | null {
  if (!unit) return null;
  const layerBucket = bucketOf(`layer:${exp.layer}`, unit);
  if (layerBucket < exp.layerFrom || layerBucket >= exp.layerTo) return null;
  const bucket = bucketOf(`exp:${exp.key}`, unit);
  let cumulative = 0;
  for (const variant of exp.variants) {
    cumulative += variant.weight;
    if (bucket < cumulative) return variant.key;
  }
  throw new Error(
    `experiment ${exp.key}: variant weights sum to ${cumulative}, not 10,000`,
  );
}

/**
 * The variants of every running experiment for one caller: a `user` experiment is assigned from the authenticated user id
 * only, a `visitor` experiment from the anonymous id only (FR-024, FR-030). An experiment without its unit is absent.
 */
export function assignAll(
  running: readonly RunningExperiment[],
  ids: { userId?: string; anonymousId?: string },
): Record<string, { variant: string }> {
  const result: Record<string, { variant: string }> = {};
  for (const exp of running) {
    const variant = assign(
      exp,
      (exp.unit === 'user' ? ids.userId : ids.anonymousId) ?? '',
    );
    if (variant !== null) result[exp.key] = { variant };
  }
  return result;
}
