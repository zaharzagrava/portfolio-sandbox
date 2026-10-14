import { murmur3 } from '@app/common/core/murmur3';

export const BUCKETS = 10_000;

/**
 * The single implementation of the assignment hash (P0811): `murmur3_x86_32(salt + ":" + unit, seed 0) mod 10000`.
 * Flags use the flag key as `salt`, experiments (S39) the experiment id, so both assign identically. The same unit
 * always lands in the same bucket of a salt; different salts bucket independently.
 */
export function bucketOf(salt: string, unit: string): number {
  return murmur3(`${salt}:${unit}`) % BUCKETS;
}
