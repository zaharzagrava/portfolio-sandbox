/**
 * k-way merge of timelines that are each already sorted newest-first
 * (lesson 10/05 #9: precomputed timeline ⊕ celebrities' recent items).
 * Entries are `<ms>|<itemId>`; a binary max-heap keyed by ms keeps it
 * O(total · log k) - with dozens of followed celebrities, re-sorting the
 * concatenation every page would waste work on items we never return.
 */
export interface TimelineEntry {
  ms: number;
  itemId: string;
}

export const encodeEntry = (e: TimelineEntry) => `${e.ms}|${e.itemId}`;
export const decodeEntry = (raw: string): TimelineEntry => {
  const [ms, itemId] = raw.split('|');
  return { ms: Number(ms), itemId };
};

export function mergeNewestFirst(
  lists: TimelineEntry[][],
  limit: number,
  before = Number.POSITIVE_INFINITY,
): TimelineEntry[] {
  const heap: { entry: TimelineEntry; list: number; index: number }[] = [];
  const push = (node: (typeof heap)[number]) => {
    heap.push(node);
    for (let i = heap.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (heap[parent].entry.ms >= heap[i].entry.ms) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let max = i;
        if (l < heap.length && heap[l].entry.ms > heap[max].entry.ms) max = l;
        if (r < heap.length && heap[r].entry.ms > heap[max].entry.ms) max = r;
        if (max === i) break;
        [heap[max], heap[i]] = [heap[i], heap[max]];
        i = max;
      }
    }
    return top;
  };

  lists.forEach((list, li) => {
    const start = list.findIndex((e) => e.ms < before);
    if (start >= 0) push({ entry: list[start], list: li, index: start });
  });

  const out: TimelineEntry[] = [];
  const seen = new Set<string>();
  while (heap.length && out.length < limit) {
    const { entry, list, index } = pop();
    if (!seen.has(entry.itemId)) {
      seen.add(entry.itemId);
      out.push(entry);
    }
    if (index + 1 < lists[list].length)
      push({ entry: lists[list][index + 1], list, index: index + 1 });
  }
  return out;
}
