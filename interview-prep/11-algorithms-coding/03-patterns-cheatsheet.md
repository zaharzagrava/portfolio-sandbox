# Algorithm Patterns Cheat Sheet (TypeScript, verified templates)

All templates were run on Node 24 with native type stripping. Note that they avoid TS **parameter properties** (`constructor(private x)`), which Node's strip-only mode rejects with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.

| Signal in the problem | Pattern |
|---|---|
| sorted array, pair/triple sums | two pointers |
| contiguous subarray/substring with constraint | sliding window |
| subarray sum = k / count ranges | prefix sum + hash map |
| "minimum X such that feasible" | binary search on answer |
| next greater/smaller, histogram | monotonic stack |
| top-k, k-th largest, merge k sorted, scheduling | heap |
| shortest path unweighted / levels | BFS |
| dependencies / ordering | topological sort |
| connectivity, grouping, cycle in undirected graph | union-find |
| weighted shortest path (non-negative) | Dijkstra |
| all combinations/permutations/subsets | backtracking |
| overlapping intervals | sort by start + sweep |
| prefix lookups | trie |
| optimal substructure + overlapping subproblems | DP (see DP doc) |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`topoSort`](../../packages/backend/libs/domains/media/domain/dag.ts#L15): topoSort implements Kahn's algorithm for the media task DAG, one of the cheat-sheet templates. _(dag.ts)_
> - [`TopKTrie`](../../packages/backend/libs/domains/discovery/domain/top-k-trie.ts#L22): TopKTrie is a prefix trie with precomputed top-K completions, matching the trie template. _(top-k-trie.ts)_
> - [`SLIDING_WINDOW`](../../packages/backend/libs/infrastructure/rate-limit/lua.ts#L49): SLIDING_WINDOW is a Lua sliding-window counter for rate limiting. _(lua.ts)_
<!-- theory-links:end -->

---

## Two pointers
```ts
function twoSumSorted(nums: number[], target: number): [number, number] | null {
  let l = 0, r = nums.length - 1;
  while (l < r) {
    const s = nums[l] + nums[r];
    if (s === target) return [l, r];
    if (s < target) l++; else r--;
  }
  return null;
}
```

## Sliding window (variable size)
```ts
// Longest substring without repeating characters
function lengthOfLongestSubstring(s: string): number {
  const last = new Map<string, number>();
  let left = 0, best = 0;
  for (let right = 0; right < s.length; right++) {
    const prev = last.get(s[right]);
    if (prev !== undefined && prev >= left) left = prev + 1;   // shrink past the duplicate
    last.set(s[right], right);
    best = Math.max(best, right - left + 1);
  }
  return best;                                                 // 'abcabcbb' → 3, 'abba' → 2
}
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SLIDING_WINDOW`](../../packages/backend/libs/infrastructure/rate-limit/lua.ts#L49): SLIDING_WINDOW keeps a weighted estimate across fixed time windows to rate-limit requests. _(lua.ts)_
> - [`RetryBudget`](../../packages/backend/libs/infrastructure/http-client/retry-budget.ts#L7): RetryBudget limits retries to a fraction of recent requests using a sliding time window. _(retry-budget.ts)_
<!-- theory-links:end -->

## Prefix sum + hash map
```ts
// Count subarrays summing to k (works with negatives, unlike sliding window)
function subarraySum(nums: number[], k: number): number {
  const count = new Map<number, number>([[0, 1]]);
  let sum = 0, res = 0;
  for (const x of nums) {
    sum += x;
    res += count.get(sum - k) ?? 0;
    count.set(sum, (count.get(sum) ?? 0) + 1);
  }
  return res;
}
```

## Binary search: lower bound and "on the answer"
```ts
function lowerBound(arr: number[], target: number): number {   // first index with arr[i] >= target
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Min ship capacity to ship all packages within `days` (monotonic feasibility)
function minShipCapacity(weights: number[], days: number): number {
  const can = (cap: number) => {
    let d = 1, cur = 0;
    for (const w of weights) { if (cur + w > cap) { d++; cur = 0; } cur += w; }
    return d <= days;
  };
  let lo = Math.max(...weights), hi = weights.reduce((a, b) => a + b, 0);
  while (lo < hi) { const mid = (lo + hi) >> 1; if (can(mid)) hi = mid; else lo = mid + 1; }
  return lo;
}
```

## Monotonic stack
```ts
function nextGreater(nums: number[]): number[] {
  const res = new Array<number>(nums.length).fill(-1);
  const st: number[] = [];                                   // indices, values decreasing
  for (let i = 0; i < nums.length; i++) {
    while (st.length && nums[st[st.length - 1]] < nums[i]) res[st.pop()!] = nums[i];
    st.push(i);
  }
  return res;                                                // [2,1,2,4,3] → [4,2,4,-1,-1]
}
```

## Heap (JS has none, so memorize this)
```ts
class MinHeap<T> {
  private a: T[] = [];
  private cmp: (x: T, y: T) => number;
  constructor(cmp: (x: T, y: T) => number) { this.cmp = cmp; }
  get size() { return this.a.length; }
  peek(): T | undefined { return this.a[0]; }
  push(v: T) {
    const a = this.a; a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]]; i = p;
    }
  }
  pop(): T | undefined {
    const a = this.a; if (!a.length) return undefined;
    const top = a[0]; const last = a.pop()!;
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

// Top-k frequent: keep a min-heap of size k → O(n log k)
function topKFrequent(nums: number[], k: number): number[] {
  const freq = new Map<number, number>();
  for (const x of nums) freq.set(x, (freq.get(x) ?? 0) + 1);
  const h = new MinHeap<[number, number]>((a, b) => a[1] - b[1]);
  for (const e of freq) { h.push(e); if (h.size > k) h.pop(); }
  const res: number[] = []; while (h.size) res.push(h.pop()![0]);
  return res.reverse();
}
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TopK`](../../packages/backend/libs/domains/discovery/domain/count-min-sketch.ts#L41): TopK is a min-heap that tracks the K largest frequency estimates. _(count-min-sketch.ts)_
<!-- theory-links:end -->

## BFS on a grid (use an index pointer as the queue, since `shift()` is O(n))
```ts
function numIslands(grid: string[][]): number {
  const R = grid.length, C = grid[0]?.length ?? 0, dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let count = 0;
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    if (grid[r][c] !== '1') continue;
    count++;
    const q: [number, number][] = [[r, c]]; grid[r][c] = '0';
    for (let h = 0; h < q.length; h++) {
      const [x, y] = q[h];
      for (const [dx, dy] of dirs) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < R && ny < C && grid[nx][ny] === '1') { grid[nx][ny] = '0'; q.push([nx, ny]); }
      }
    }
  }
  return count;
}
```

## Topological sort (Kahn) + cycle detection
```ts
function topoSort(n: number, edges: [number, number][]): number[] | null {
  const adj: number[][] = Array.from({ length: n }, () => []);
  const indeg = new Array<number>(n).fill(0);
  for (const [u, v] of edges) { adj[u].push(v); indeg[v]++; }
  const q: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) q.push(i);
  const order: number[] = [];
  for (let h = 0; h < q.length; h++) {
    const u = q[h]; order.push(u);
    for (const v of adj[u]) if (--indeg[v] === 0) q.push(v);
  }
  return order.length === n ? order : null;                  // null → cycle
}
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`topoSort`](../../packages/backend/libs/domains/media/domain/dag.ts#L15): topoSort runs Kahn's algorithm and throws an error naming the cycle nodes when it finds one. _(dag.ts)_
> - [`readyTasks`](../../packages/backend/libs/domains/media/domain/dag.ts#L36): readyTasks returns the tasks whose dependencies are satisfied, which is the zero in-degree frontier. _(dag.ts)_
> - [`videoPipeline`](../../packages/backend/libs/domains/media/domain/dag.ts#L42): videoPipeline builds the probe → (renditions ‖ poster) → package → publish DAG that topoSort orders. _(dag.ts)_
<!-- theory-links:end -->

## Dijkstra
```ts
function dijkstra(n: number, edges: [number, number, number][], src: number): number[] {
  const adj: [number, number][][] = Array.from({ length: n }, () => []);
  for (const [u, v, w] of edges) adj[u].push([v, w]);
  const dist = new Array<number>(n).fill(Infinity); dist[src] = 0;
  const pq = new MinHeap<[number, number]>((a, b) => a[0] - b[0]);
  pq.push([0, src]);
  while (pq.size) {
    const [d, u] = pq.pop()!;
    if (d > dist[u]) continue;                               // stale entry
    for (const [v, w] of adj[u]) if (d + w < dist[v]) { dist[v] = d + w; pq.push([dist[v], v]); }
  }
  return dist;
}
```

## Union-Find (path compression + union by rank)
```ts
class DSU {
  parent: number[]; rank: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); this.rank = new Array(n).fill(0); }
  find(x: number): number {
    while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; }
    return x;
  }
  union(a: number, b: number): boolean {
    let ra = this.find(a), rb = this.find(b);
    if (ra === rb) return false;                             // already connected (cycle in undirected graph)
    if (this.rank[ra] < this.rank[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra]++;
    return true;
  }
}
```

## Backtracking
```ts
function subsets(nums: number[]): number[][] {
  const res: number[][] = [], cur: number[] = [];
  const bt = (i: number) => {
    if (i === nums.length) { res.push([...cur]); return; }
    cur.push(nums[i]); bt(i + 1); cur.pop();                 // take
    bt(i + 1);                                               // skip
  };
  bt(0);
  return res;
}
function permute(nums: number[]): number[][] {
  const res: number[][] = [], cur: number[] = [], used = new Array(nums.length).fill(false);
  const bt = () => {
    if (cur.length === nums.length) { res.push([...cur]); return; }
    for (let i = 0; i < nums.length; i++) {
      if (used[i]) continue;
      used[i] = true; cur.push(nums[i]); bt(); cur.pop(); used[i] = false;
    }
  };
  bt();
  return res;
}
```

## Intervals
```ts
function mergeIntervals(iv: [number, number][]): [number, number][] {
  const s = [...iv].sort((a, b) => a[0] - b[0]);
  const res: [number, number][] = [];
  for (const [a, b] of s) {
    if (res.length && a <= res[res.length - 1][1]) res[res.length - 1][1] = Math.max(res[res.length - 1][1], b);
    else res.push([a, b]);
  }
  return res;
}
// Min meeting rooms: sweep sorted starts vs sorted ends
function minMeetingRooms(iv: [number, number][]): number {
  const starts = iv.map(i => i[0]).sort((a, b) => a - b), ends = iv.map(i => i[1]).sort((a, b) => a - b);
  let rooms = 0, best = 0, e = 0;
  for (const s of starts) {
    while (e < ends.length && ends[e] <= s) { e++; rooms--; }
    rooms++; best = Math.max(best, rooms);
  }
  return best;
}
```

## LRU cache (Map keeps insertion order)
```ts
class LRUCache {
  private m = new Map<number, number>();
  private cap: number;
  constructor(cap: number) { this.cap = cap; }
  get(k: number): number {
    if (!this.m.has(k)) return -1;
    const v = this.m.get(k)!; this.m.delete(k); this.m.set(k, v);   // move to most-recent
    return v;
  }
  put(k: number, v: number) {
    this.m.delete(k); this.m.set(k, v);
    if (this.m.size > this.cap) this.m.delete(this.m.keys().next().value!); // evict least-recent
  }
}
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`InMemoryTokenBucket`](../../packages/backend/libs/infrastructure/rate-limit/in-memory-token-bucket.ts#L7): InMemoryTokenBucket is a rate limiter with LRU-like eviction and a bounded capacity. _(in-memory-token-bucket.ts)_
<!-- theory-links:end -->

## Trie
```ts
class TrieNode { children = new Map<string, TrieNode>(); end = false; }
class Trie {
  private root = new TrieNode();
  insert(w: string) {
    let n = this.root;
    for (const ch of w) {
      let next = n.children.get(ch);
      if (!next) { next = new TrieNode(); n.children.set(ch, next); }
      n = next;
    }
    n.end = true;
  }
  search(w: string) { return this.walk(w)?.end ?? false; }
  startsWith(p: string) { return this.walk(p) !== null; }
  private walk(s: string): TrieNode | null {
    let n: TrieNode | undefined = this.root;
    for (const ch of s) { n = n.children.get(ch); if (!n) return null; }
    return n;
  }
}
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TopKTrie`](../../packages/backend/libs/domains/discovery/domain/top-k-trie.ts#L22): TopKTrie is a prefix trie that precomputes top-K completions at each node. _(top-k-trie.ts)_
> - [`normalizeQuery`](../../packages/backend/libs/domains/discovery/domain/top-k-trie.ts#L79): normalizeQuery lowercases and trims queries into the canonical form the trie is keyed on. _(top-k-trie.ts)_
<!-- theory-links:end -->

---

## Complexity reference
| Structure / op | Time |
|---|---|
| Map/Set get/set/has | O(1) avg |
| Array push/pop | O(1) amortized; `shift`/`unshift`/`splice` O(n) |
| sort | O(n log n) (TimSort in V8, stable) |
| heap push/pop | O(log n); build O(n) |
| BFS/DFS | O(V + E) |
| Dijkstra (binary heap) | O((V + E) log V) |
| Union-find (both optimizations) | ~O(α(n)) ≈ O(1) |
