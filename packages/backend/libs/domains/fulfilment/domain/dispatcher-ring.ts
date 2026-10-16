import { createHash } from 'node:crypto';

/**
 * Consistent-hash ring over the live dispatcher instances (S20 R-8, A25, pattern P1105). Pure: `ownerOf(city,
 * instances)` depends on nothing else. Ownership is an optimisation; correctness never depends on it (FR-043).
 */
export const VIRTUAL_NODES = 128;

/** First 48 bits of SHA-1 as a safe integer position on the ring. */
const position = (text: string): number =>
  createHash('sha1').update(text).digest().readUIntBE(0, 6);

interface Ring {
  points: number[];
  owners: string[];
}

const MAX_CACHED_RINGS = 8;
const rings = new Map<string, Ring>();

function ringFor(instances: readonly string[]): Ring {
  const unique = [...new Set(instances)].sort();
  const cacheKey = JSON.stringify(unique);
  const cached = rings.get(cacheKey);
  if (cached) return cached;
  const entries: Array<[number, string]> = [];
  for (const instance of unique)
    for (let i = 0; i < VIRTUAL_NODES; i++)
      entries.push([position(`${instance}#${i}`), instance]);
  // Ties (a hash collision between two instances) break by instance id so the result is order independent.
  entries.sort(
    (a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0),
  );
  const ring: Ring = {
    points: entries.map((e) => e[0]),
    owners: entries.map((e) => e[1]),
  };
  if (rings.size >= MAX_CACHED_RINGS)
    rings.delete(rings.keys().next().value as string);
  rings.set(cacheKey, ring);
  return ring;
}

/** Owner of a city: the instance of the first ring point at or after `sha1(city)`; `null` for an empty set. */
export function ownerOf(
  city: string,
  instances: readonly string[],
): string | null {
  if (instances.length === 0) return null;
  const { points, owners } = ringFor(instances);
  const target = position(city);
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return owners[lo % owners.length];
}
