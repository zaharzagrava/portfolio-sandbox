import { murmur3 } from '@app/common/core/murmur3';

const MAX_COUNTER = 0xffffffff;

/**
 * Count-Min Sketch (S35 FR-016, pattern P1102): frequency estimates for a stream with millions of distinct keys in FIXED
 * memory (width × depth counters). Estimates never undercount; with width w the overcount is ≤ e/w · N with probability
 * 1 - e^-depth. Counters saturate at 2^32 - 1 instead of wrapping, so an estimate never decreases when events are added.
 * 2^16 × 4 × 4 bytes ≈ 1 MiB.
 */
export class CountMinSketch {
  private readonly table: Uint32Array;

  constructor(
    readonly width = 1 << 16,
    readonly depth = 4,
  ) {
    this.table = new Uint32Array(width * depth);
  }

  /** Memory held by the counters, whatever the number of distinct keys. */
  get byteSize(): number {
    return this.table.byteLength;
  }

  /** Adds `count` and returns the new estimate. */
  add(key: string, count = 1): number {
    let estimate = MAX_COUNTER;
    for (let row = 0; row < this.depth; row++) {
      const i = this.cell(row, key);
      const next = Math.min(MAX_COUNTER, this.table[i] + count);
      this.table[i] = next;
      if (next < estimate) estimate = next;
    }
    return estimate;
  }

  estimate(key: string): number {
    let estimate = MAX_COUNTER;
    for (let row = 0; row < this.depth; row++) {
      const value = this.table[this.cell(row, key)];
      if (value < estimate) estimate = value;
    }
    return estimate;
  }

  /** Adds `other` cell by cell (saturating); the result equals one sketch fed both streams. */
  merge(other: CountMinSketch): void {
    if (other.width !== this.width || other.depth !== this.depth)
      throw new Error('cannot merge sketches of different dimensions');
    for (let i = 0; i < this.table.length; i++)
      this.table[i] = Math.min(MAX_COUNTER, this.table[i] + other.table[i]);
  }

  private cell(row: number, key: string): number {
    return row * this.width + (murmur3(key, row * 0x9e3779b1) % this.width);
  }
}
