/**
 * k-way merge of timelines (S26 D2, AS-18/26/31). Every list holds entries `(ms, itemId)` where `itemId` is the
 * sortable item id; the global order is `ms` descending, then `itemId` descending, so equal milliseconds are ordered
 * deterministically. Duplicates (the same item id in several lists) are returned once. The cursor is the last entry of
 * the previous page and is exclusive. A binary heap keeps it O(total log k).
 */
export interface TimelineEntry {
  ms: number;
  itemId: string;
}

export const encodeEntry = (e: TimelineEntry) => `${e.ms}|${e.itemId}`;
export const decodeEntry = (raw: string): TimelineEntry => {
  const sep = raw.indexOf('|');
  return { ms: Number(raw.slice(0, sep)), itemId: raw.slice(sep + 1) };
};

/** Negative when `a` is newer than `b` (comes first), positive when older, 0 when the same position. */
export function compareEntries(a: TimelineEntry, b: TimelineEntry): number {
  if (a.ms !== b.ms) return a.ms > b.ms ? -1 : 1;
  if (a.itemId === b.itemId) return 0;
  return a.itemId > b.itemId ? -1 : 1;
}

interface Node {
  entry: TimelineEntry;
  list: TimelineEntry[];
  index: number;
}

/**
 * @param before exclusive cursor: an entry (resume after it), or a number of milliseconds (entries strictly older).
 */
export function mergeNewestFirst(
  lists: readonly (readonly TimelineEntry[])[],
  limit: number,
  before?: TimelineEntry | number,
): TimelineEntry[] {
  if (limit <= 0) return [];
  const isAfterCursor = (e: TimelineEntry): boolean => {
    if (before === undefined) return true;
    if (typeof before === 'number') return e.ms < before;
    return compareEntries(e, before) > 0;
  };

  const heap: Node[] = [];
  const higher = (a: Node, b: Node) => compareEntries(a.entry, b.entry) < 0;
  const push = (node: Node) => {
    heap.push(node);
    for (let i = heap.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (!higher(heap[i], heap[parent])) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = (): Node => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < heap.length && higher(heap[l], heap[best])) best = l;
        if (r < heap.length && higher(heap[r], heap[best])) best = r;
        if (best === i) break;
        [heap[best], heap[i]] = [heap[i], heap[best]];
        i = best;
      }
    }
    return top;
  };

  for (const raw of lists) {
    // Pushes may arrive in any order; the heap needs each list sorted.
    let list = raw as TimelineEntry[];
    for (let i = 1; i < list.length; i++) {
      if (compareEntries(list[i - 1], list[i]) > 0) {
        list = [...raw].sort(compareEntries);
        break;
      }
    }
    const start = list.findIndex(isAfterCursor);
    if (start >= 0) push({ entry: list[start], list, index: start });
  }

  const out: TimelineEntry[] = [];
  const seen = new Set<string>();
  while (heap.length && out.length < limit) {
    const { entry, list, index } = pop();
    if (!seen.has(entry.itemId)) {
      seen.add(entry.itemId);
      out.push(entry);
    }
    if (index + 1 < list.length)
      push({ entry: list[index + 1], list, index: index + 1 });
  }
  return out;
}
