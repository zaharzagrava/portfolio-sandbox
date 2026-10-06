import { createHash } from 'node:crypto';

const hash32 = (value: string) => createHash('md5').update(value).digest().readUInt32BE(0);

/**
 * Consistent hashing with virtual nodes (10/09 #34). Every editor of a draft
 * must reach the SAME instance (the in-memory Y.Doc lives there); when an
 * instance joins or leaves, only ~1/N of the drafts move - the others keep
 * their warm rooms. Virtual nodes (256 per instance: worst instance within ~10% of fair share for 5 nodes) smooth out the load
 * imbalance a single point per instance would give.
 */
export class HashRing {
  private readonly points: { hash: number; node: string }[];

  constructor(
    nodes: string[],
    private readonly vnodes = 256,
  ) {
    this.points = nodes
      .flatMap((node) => Array.from({ length: vnodes }, (_, i) => ({ hash: hash32(`${node}#${i}`), node })))
      .sort((a, b) => a.hash - b.hash || a.node.localeCompare(b.node));
  }

  get size(): number {
    return this.points.length / this.vnodes;
  }

  /** First point clockwise from the key's hash (binary search), wrapping around. */
  nodeFor(key: string): string | null {
    if (this.points.length === 0) return null;
    const h = hash32(key);
    let lo = 0;
    let hi = this.points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.points[mid].hash < h) lo = mid + 1;
      else hi = mid;
    }
    return this.points[lo === this.points.length ? 0 : lo].node;
  }
}
