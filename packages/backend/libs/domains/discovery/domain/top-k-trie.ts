export interface Suggestion {
  query: string;
  count: number;
}

interface TrieNode {
  /** Created on the first child: most nodes sit at the depth cap and are leaves. */
  children: Map<string, TrieNode> | null;
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
  private readonly root: TrieNode = { children: null, top: [] };
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
      let next = node.children?.get(ch);
      if (!next) {
        next = { children: null, top: [] };
        (node.children ??= new Map()).set(ch, next);
        this.nodes++;
      }
      node = next;
      if (node.top.length < this.k) node.top.push(s);
    }
  }

  lookup(prefix: string, limit = this.k): Suggestion[] {
    let node: TrieNode | undefined = this.root;
    for (const ch of [...prefix.slice(0, this.maxPrefix)]) {
      node = node.children?.get(ch);
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
      (a, b) =>
        b.count - a.count ||
        (a.query < b.query ? -1 : a.query > b.query ? 1 : 0),
    );
    for (let i = 0; i < sorted.length; i++) {
      trie.insert(sorted[i]);
      if (i % chunk === chunk - 1) await new Promise((r) => setImmediate(r));
    }
    return trie;
  }
}
