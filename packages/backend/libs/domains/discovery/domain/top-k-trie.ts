export interface Suggestion {
  query: string;
  count: number;
}

interface TrieNode {
  children: Map<string, TrieNode>;
  /** Precomputed best completions for the prefix ending here (≤ K, by count desc). */
  top: Suggestion[];
}

/**
 * Prefix → top-K completions (lesson 10/05 #12, 11/03 trie). Built offline
 * from aggregated query logs; looked up per keystroke in O(prefix length)
 * with no subtree traversal, because every node already holds its top K.
 *
 * Build trick: insert queries sorted by count DESC - the first K queries that
 * pass through a node ARE its top K, so no per-node sorting or heaps.
 * Memory is bounded by `maxPrefix` (deeper prefixes add nodes but no new info
 * for typing users) and K.
 */
export class TopKTrie {
  private readonly root: TrieNode = { children: new Map(), top: [] };
  private nodes = 1;

  constructor(
    private readonly k = 10,
    private readonly maxPrefix = 20,
  ) {}

  /** Requires calls in descending `count` order (see `buildFrom`). */
  insert(s: Suggestion): void {
    let node = this.root;
    if (node.top.length < this.k) node.top.push(s);
    const chars = [...s.query.slice(0, this.maxPrefix)];
    for (const ch of chars) {
      let next = node.children.get(ch);
      if (!next) {
        next = { children: new Map(), top: [] };
        node.children.set(ch, next);
        this.nodes++;
      }
      node = next;
      if (node.top.length < this.k) node.top.push(s);
    }
  }

  lookup(prefix: string, limit = this.k): Suggestion[] {
    let node: TrieNode | undefined = this.root;
    for (const ch of [...prefix.slice(0, this.maxPrefix)]) {
      node = node.children.get(ch);
      if (!node) return [];
    }
    // Prefix longer than maxPrefix: the node's list is a superset; filter exact.
    return node.top.filter((s) => s.query.startsWith(prefix)).slice(0, limit);
  }

  size(): number {
    return this.nodes;
  }

  /**
   * Builds without blocking the event loop: yields to it every `chunk`
   * inserts (lesson 02/01 §3 "partition the work") so a 200k-query rebuild
   * on a serving node never stalls in-flight requests.
   */
  static async buildFrom(
    items: Suggestion[],
    k = 10,
    maxPrefix = 20,
    chunk = 5_000,
  ): Promise<TopKTrie> {
    const trie = new TopKTrie(k, maxPrefix);
    const sorted = [...items].sort(
      (a, b) => b.count - a.count || a.query.localeCompare(b.query),
    );
    for (let i = 0; i < sorted.length; i++) {
      trie.insert(sorted[i]);
      if (i % chunk === chunk - 1) await new Promise((r) => setImmediate(r));
    }
    return trie;
  }
}

/** One canonical form for logging and lookup: lowercase, single spaces, trimmed, bounded. */
export function normalizeQuery(q: string): string {
  return q
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}
