import type { NeighbourEntry } from './neighbour-entry';
import type { Candidate } from './recommendation-ranking';

export interface Seed {
  seed: NeighbourEntry;
  /** The seed's own sanitised list. */
  list: readonly NeighbourEntry[];
}

/**
 * Candidate pool of the cold-start rail (S34 FR-006): every direct neighbour (hop 1), plus the neighbours of the seeds
 * (hop 2) scored `seed · entry · decay`. The best path wins when a product is reachable through several seeds; a direct
 * neighbour keeps its direct score and hop; the requested product is never a candidate. Ranking is left to
 * `rankCandidates`.
 */
export function blendTwoHop(
  productId: string,
  direct: readonly NeighbourEntry[],
  seeds: readonly Seed[],
  decay: number,
): Candidate[] {
  const pool = new Map<string, Candidate>();
  for (const { id, score } of direct)
    if (id !== productId) pool.set(id, { productId: id, score, hops: 1 });

  for (const { seed, list } of seeds)
    for (const entry of list) {
      if (entry.id === productId) continue;
      const known = pool.get(entry.id);
      if (known?.hops === 1) continue;
      const score = seed.score * entry.score * decay;
      if (!known || score > known.score)
        pool.set(entry.id, { productId: entry.id, score, hops: 2 });
    }
  return [...pool.values()];
}
