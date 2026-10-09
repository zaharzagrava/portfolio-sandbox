import { murmur3 } from '@app/common/core/murmur3';

export interface ExperimentDef {
  key: string;
  status: 'DRAFT' | 'RUNNING' | 'STOPPED';
  variants: { key: string; weight: number }[];
  layer: string;
  layerFrom: number;
  layerTo: number;
}

/**
 * Two independent hashes (10/02 Ex2):
 *   layer bucket   = murmur3("layer:<layer>:<unit>")  → which experiment of the layer (if any) owns the user
 *   variant bucket = murmur3("exp:<key>:<unit>")      → which variant inside that experiment
 * Same murmur3 as the flag SDK, so web/mobile/edge can compute assignments identically.
 */
export function assign(exp: ExperimentDef, unit: string): string | null {
  if (exp.status !== 'RUNNING' || !unit) return null;
  const layerBucket = murmur3(`layer:${exp.layer}:${unit}`) % 10_000;
  if (layerBucket < exp.layerFrom || layerBucket >= exp.layerTo) return null;
  const total = exp.variants.reduce((s, v) => s + v.weight, 0);
  const bucket =
    (murmur3(`exp:${exp.key}:${unit}`) % 10_000) * (total / 10_000);
  let cumulative = 0;
  for (const v of exp.variants) {
    cumulative += v.weight;
    if (bucket < cumulative) return v.key;
  }
  return exp.variants[exp.variants.length - 1].key;
}
