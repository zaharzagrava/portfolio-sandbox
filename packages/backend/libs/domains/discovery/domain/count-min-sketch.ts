import { murmur3 } from '@app/common/core/murmur3';

/**
 * Count-Min Sketch (10/09 #32): frequency estimates for a stream with
 * millions of distinct keys in FIXED memory (width × depth counters).
 * Estimates never undercount; with width w the overcount is ≤ e/w · N with
 * probability 1 - e^-depth. 2^16 × 4 × 4 bytes ≈ 1 MB per window.
 */
export class CountMinSketch {
  private readonly table: Uint32Array;

  constructor(
    readonly width = 1 << 16,
    readonly depth = 4,
  ) {
    this.table = new Uint32Array(width * depth);
  }

  add(key: string, count = 1): number {
    let estimate = Infinity;
    for (let row = 0; row < this.depth; row++) {
      const i =
        row * this.width + (murmur3(key, row * 0x9e3779b1) % this.width);
      this.table[i] += count;
      estimate = Math.min(estimate, this.table[i]);
    }
    return estimate;
  }

  estimate(key: string): number {
    let estimate = Infinity;
    for (let row = 0; row < this.depth; row++)
      estimate = Math.min(
        estimate,
        this.table[
          row * this.width + (murmur3(key, row * 0x9e3779b1) % this.width)
        ],
      );
    return estimate;
  }
}

/**
 * Heavy hitters: min-heap of the K largest estimates + index for O(log K)
 * updates. Each event: sketch.add → if the key is in the heap, update its
 * count; else if it beats the heap minimum, it replaces the minimum.
 */
export class TopK {
  private heap: { key: string; count: number }[] = [];
  private readonly index = new Map<string, number>();

  constructor(readonly k: number) {}

  offer(key: string, count: number): void {
    const at = this.index.get(key);
    if (at !== undefined) {
      this.heap[at].count = count;
      this.siftDown(at);
      return;
    }
    if (this.heap.length < this.k) {
      this.heap.push({ key, count });
      this.index.set(key, this.heap.length - 1);
      this.siftUp(this.heap.length - 1);
    } else if (count > this.heap[0].count) {
      this.index.delete(this.heap[0].key);
      this.heap[0] = { key, count };
      this.index.set(key, 0);
      this.siftDown(0);
    }
  }

  /** Largest first. */
  top(): { key: string; count: number }[] {
    return [...this.heap].sort(
      (a, b) => b.count - a.count || a.key.localeCompare(b.key),
    );
  }

  private siftUp(i: number) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent].count <= this.heap[i].count) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private siftDown(i: number) {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;
      if (
        l < this.heap.length &&
        this.heap[l].count < this.heap[smallest].count
      )
        smallest = l;
      if (
        r < this.heap.length &&
        this.heap[r].count < this.heap[smallest].count
      )
        smallest = r;
      if (smallest === i) return;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number) {
    [this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]];
    this.index.set(this.heap[a].key, a);
    this.index.set(this.heap[b].key, b);
  }
}

/**
 * Tumbling 1-minute windows by EVENT time with a watermark
 * (max event time seen − allowed lateness). Windows close when the watermark
 * passes their end; events for already-closed windows are counted as late
 * (trending is approximate - they're dropped; billing uses the exact path).
 */
export class TumblingWindows<S> {
  private readonly open = new Map<number, S>();
  private maxEventTime = 0;
  lateEvents = 0;

  constructor(
    private readonly sizeMs: number,
    private readonly allowedLatenessMs: number,
    private readonly create: () => S,
  ) {}

  /** Returns the window state for the event, or null if it's too late. */
  stateFor(eventTime: number): S | null {
    this.maxEventTime = Math.max(this.maxEventTime, eventTime);
    const start = eventTime - (eventTime % this.sizeMs);
    if (start + this.sizeMs <= this.watermark() && !this.open.has(start)) {
      this.lateEvents++;
      return null;
    }
    let state = this.open.get(start);
    if (!state) {
      state = this.create();
      this.open.set(start, state);
    }
    return state;
  }

  watermark(): number {
    return this.maxEventTime - this.allowedLatenessMs;
  }

  /** Windows whose end is behind the watermark (or all, on shutdown). */
  closeReady(all = false): { start: number; state: S }[] {
    const closed: { start: number; state: S }[] = [];
    for (const [start, state] of [...this.open].sort((a, b) => a[0] - b[0])) {
      if (!all && start + this.sizeMs > this.watermark()) continue;
      this.open.delete(start);
      closed.push({ start, state });
    }
    return closed;
  }
}
