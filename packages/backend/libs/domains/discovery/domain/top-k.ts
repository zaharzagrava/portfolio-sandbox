interface Entry {
  key: string;
  count: number;
}

/** `a` ranks below `b`: a smaller count, or an equal count and a key that sorts later by code unit (never by locale). */
const below = (a: Entry, b: Entry) =>
  a.count < b.count || (a.count === b.count && a.key > b.key);

/**
 * Heavy hitters (S35 FR-016): a min-heap of the K largest estimates plus an index for O(log K) updates. The order is
 * total (count, then key ascending by code unit), so the same offers give the same heap on every replay. A key already
 * held is updated in place; a new key enters only when it ranks above the current minimum.
 */
export class TopK {
  private readonly heap: Entry[] = [];
  private readonly index = new Map<string, number>();

  constructor(readonly k: number) {}

  get size(): number {
    return this.heap.length;
  }

  offer(key: string, count: number): void {
    const at = this.index.get(key);
    if (at !== undefined) {
      this.heap[at].count = count;
      this.siftDown(at);
      this.siftUp(at);
      return;
    }
    const entry = { key, count };
    if (this.heap.length < this.k) {
      this.heap.push(entry);
      this.index.set(key, this.heap.length - 1);
      this.siftUp(this.heap.length - 1);
    } else if (below(this.heap[0], entry)) {
      this.index.delete(this.heap[0].key);
      this.heap[0] = entry;
      this.index.set(key, 0);
      this.siftDown(0);
    }
  }

  /** Largest first; equal counts by key ascending. */
  top(): { key: string; count: number }[] {
    return this.heap
      .map((e) => ({ key: e.key, count: e.count }))
      .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
  }

  private siftUp(i: number) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!below(this.heap[i], this.heap[parent])) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private siftDown(i: number) {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;
      if (l < this.heap.length && below(this.heap[l], this.heap[smallest]))
        smallest = l;
      if (r < this.heap.length && below(this.heap[r], this.heap[smallest]))
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
