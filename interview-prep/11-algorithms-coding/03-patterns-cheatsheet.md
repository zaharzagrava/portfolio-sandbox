# Algorithm Patterns Cheat Sheet (TypeScript, verified templates)

All templates were run on Node 22+ with native type stripping (`node file.ts`). They avoid the syntax that strip-only mode rejects with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`: **parameter properties** (`constructor(private x)`), `enum` and `namespace`.

Each section gives **When** (the signal in the problem), the idea and a template, **Cost** (time / extra space), **Trap** (the usual bug) and **Drills** (problems from the live-coding set that use it).

| Signal in the problem | Pattern |
|---|---|
| "seen before?", pair with a target sum, counts, anagrams, grouping | hash map / set |
| element that appears more than n/2 times, O(1) space | Boyer-Moore vote |
| serialize a list of strings, run lengths, symbol lookahead | string scanning |
| sorted array, pair/triple sums, palindrome, in-place filtering | two pointers |
| contiguous subarray/substring with a constraint | sliding window |
| range sums, subarray sum = k, "everything left/right of i" | prefix sums / prefix-suffix passes |
| matching brackets, postfix expressions, O(1) min | stack |
| next greater/smaller, histogram, window maximum | monotonic stack / deque |
| sorted or rotated input, "minimum X such that feasible" | binary search |
| reverse, merge, middle, cycle, n-th from end in a list | linked-list pointers |
| overlapping intervals, rooms, removals | intervals (sort + sweep / greedy) |
| tree depth, paths, levels, BST order | tree DFS / BFS |
| top-k, k-th largest, merge k sorted, running median, scheduling | heap |
| islands, shortest path unweighted / levels | BFS / DFS |
| dependencies / ordering | topological sort |
| connectivity, grouping, cycle in undirected graph | union-find |
| weighted shortest path (non-negative) | Dijkstra |
| all combinations/permutations/subsets | backtracking |
| "can you reach", local choice provably safe | greedy |
| optimal substructure + overlapping subproblems | DP (see the [DP doc](02-dynamic-programming.md)) |
| prefix lookups, wildcard word search | trie |
| pairs cancel, count set bits | bit tricks |
| fixed capacity, evict least recently used | LRU (Map order) |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`topoSort`](../../packages/backend/libs/domains/media/domain/dag.ts#L15): topoSort implements Kahn's algorithm for the media task DAG, one of the cheat-sheet templates. _(dag.ts)_
> - [`TopKTrie`](../../packages/backend/libs/domains/discovery/domain/top-k-trie.ts#L22): TopKTrie is a prefix trie with precomputed top-K completions, matching the trie template. _(top-k-trie.ts)_
> - [`SLIDING_WINDOW`](../../packages/backend/libs/infrastructure/rate-limit/lua.ts#L49): SLIDING_WINDOW is a Lua sliding-window counter for rate limiting. _(lua.ts)_
<!-- theory-links:end -->

---

## Hashing: lookups, counts, canonical keys
**When:** an inner loop only searches for something ("is there an earlier x?"), or you compare/group things by content. A Map/Set turns that search into an O(1) average lookup.
```ts
function counts<T>(xs: Iterable<T>): Map<T, number> {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}
function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) { const k = key(x); let g = m.get(k); if (!g) m.set(k, g = []); g.push(x); }
  return m;
}
// Canonical key for anagrams: 26-letter count signature, O(k) per word
const anagramKey = (w: string) => {
  const c = new Array<number>(26).fill(0);
  for (const ch of w) c[ch.charCodeAt(0) - 97]++;
  return c.join(',');                                       // the separator matters: "1,11" ≠ "11,1"
};
// groupBy(['eat', 'tea', 'tan'], anagramKey) → [['eat','tea'], ['tan']]
```
- **Complement lookup:** for each x, look up `target − x` *before* inserting x, so x never pairs with itself (`[3,3]`, target 6).
- **Compare two multisets:** check lengths, count one, decrement with the other; a missing or exhausted key means "different". A 26-slot array is O(1) space for lowercase letters.
- **Canonical key:** anagrams → sorted letters (O(k log k)) or the count signature (O(k)); "same pattern" → first-seen index of each char (`paper` → `0,1,0,3,4`). A one-to-one mapping (bijection) needs two maps, s→t and t→s; one map accepts `badc` → `baba`.
- **Runs in a Set:** start counting only at an x where `x − 1` is absent, then extend upward. Runs are disjoint, so all inner steps together are ≤ n. Iterate the Set, not the array, so duplicates do no extra work.

**Cost:** O(n) time, O(n) space. **Trap:** count keys without separators collide; iterate strings with `for...of` (code points) and use a Map, not a 26-array, for Unicode.
Drills: [algo-001](../practice/live-coding/03-algorithms.md#algo-001), [algo-002](../practice/live-coding/03-algorithms.md#algo-002), [algo-003](../practice/live-coding/03-algorithms.md#algo-003), [algo-004](../practice/live-coding/03-algorithms.md#algo-004), [algo-007](../practice/live-coding/03-algorithms.md#algo-007), [algo-048](../practice/live-coding/03-algorithms.md#algo-048)

## Boyer-Moore majority vote
**When:** an element appears more than n/2 times and you need O(1) space.
```ts
function majority(nums: number[]): number {
  let cand = 0, votes = 0;
  for (const x of nums) {
    if (votes === 0) cand = x;
    votes += x === cand ? 1 : -1;                            // each other value cancels one vote
  }
  return cand;                                               // [2,2,1,1,1,2,2] → 2
}
```
The majority has more votes than everything else combined, so it cannot be fully cancelled. **Cost:** O(n) / O(1). **Trap:** if a majority is not guaranteed, make a second pass and check `count(cand) > n / 2`.
Drills: [algo-008](../practice/live-coding/03-algorithms.md#algo-008)

## String scanning and encoding
**When:** serialize/parse strings, compress runs, read symbols with lookahead, compare columns.
```ts
// Length-prefix framing: "len#payload", so the payload may contain '#' or anything else
function encode(strs: string[]): string { return strs.map(s => `${s.length}#${s}`).join(''); }
function decode(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    const hash = s.indexOf('#', i);                          // the first '#' after i ends the length
    const len = Number(s.slice(i, hash));
    out.push(s.slice(hash + 1, hash + 1 + len));             // jump exactly len chars; never parse payload
    i = hash + 1 + len;
  }
  return out;
}
// Runs of equal characters: i = run start, j = first index after the run
function runs(s: string): [string, number][] {
  const res: [string, number][] = [];
  for (let i = 0; i < s.length; ) {
    let j = i; while (j < s.length && s[j] === s[i]) j++;
    res.push([s[i], j - i]); i = j;
  }
  return res;                                                // 'aaabcc' → [['a',3],['b',1],['c',2]]
}
```
- **Framing:** a plain delimiter breaks once a string contains it; length-prefixing is how binary protocols frame messages (chunked encoding, TLV).
- **Run-length:** build output in an array and `join` once; counts can have several digits (`a12`).
- **Lookahead:** Roman numerals: subtract a symbol's value when the next symbol is larger, otherwise add.
- **Vertical scan:** compare column i across all strings; stop at the first mismatch or at the end of the shortest string (longest common prefix). Handle an empty list.

**Cost:** O(total length). **Trap:** decoding by `split('#')`; repeated `+=` in a loop where an array + `join` is expected.
Drills: [algo-009](../practice/live-coding/03-algorithms.md#algo-009), [algo-045](../practice/live-coding/03-algorithms.md#algo-045), [algo-046](../practice/live-coding/03-algorithms.md#algo-046), [algo-049](../practice/live-coding/03-algorithms.md#algo-049)

## Two pointers
Three shapes, each O(n) because every step moves a pointer for good:
- **Opposite ends** (`l`, `r` move inward). Sorted pair sum: too small → `l++`, too big → `r--`. Container with most water: area is capped by the shorter line, so move the shorter one. Palindrome: compare `s[l]`, `s[r]` and move both.
- **Same direction (read/write):** `read` scans everything; `write` marks the end of the kept prefix (move zeroes, remove duplicates, in-place compression).
- **Gap and fast/slow:** see Linked lists.
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
// kSum base case: sort, fix i, two-pointer the rest, skip equal neighbours to avoid duplicate triples
function threeSum(nums: number[]): number[][] {
  const a = [...nums].sort((x, y) => x - y), res: number[][] = [];
  for (let i = 0; i < a.length - 2; i++) {
    if (i > 0 && a[i] === a[i - 1]) continue;
    let l = i + 1, r = a.length - 1;
    while (l < r) {
      const s = a[i] + a[l] + a[r];
      if (s < 0) l++; else if (s > 0) r--;
      else { res.push([a[i], a[l], a[r]]); l++; r--; while (l < r && a[l] === a[l - 1]) l++; }
    }
  }
  return res;                                                // [-1,0,1,2,-1,-4] → [[-1,-1,2],[-1,0,1]]
}
// Read/write: keep elements in order, return the new length
function keepInPlace(nums: number[], keep: (x: number) => boolean): number {
  let write = 0;
  for (let read = 0; read < nums.length; read++)
    if (keep(nums[read])) { [nums[write], nums[read]] = [nums[read], nums[write]]; write++; } // rejected values drift to the back
  return write;                                              // keep x !== 0 on [0,1,0,3,12] → [1,3,12,0,0]
}
// Trapping rain water: water over a bar = min(maxLeft, maxRight) − height.
// Process the lower side: the other side surely has a wall at least that tall.
function trap(h: number[]): number {
  let l = 0, r = h.length - 1, lMax = 0, rMax = 0, water = 0;
  while (l < r) {
    if (h[l] < h[r]) { lMax = Math.max(lMax, h[l]); water += lMax - h[l++]; }
    else { rMax = Math.max(rMax, h[r]); water += rMax - h[r--]; }
  }
  return water;                                              // [0,1,0,2,1,0,1,3,2,1,2,1] → 6
}
const isPalRange = (s: string, l: number, r: number) => { while (l < r) if (s[l++] !== s[r--]) return false; return true; };
// "Palindrome after deleting at most one char": at the first mismatch, try BOTH isPalRange(l+1, r) and isPalRange(l, r-1)
```
**Cost:** O(n) / O(1); 3Sum O(n²). **Trap:** default `sort()` compares strings; in 3Sum skip duplicates for `i` and for `l` after a hit; for "valid palindrome" skip non-alphanumerics before comparing (digits count) and lowercase both sides.
Drills: [algo-010](../practice/live-coding/03-algorithms.md#algo-010), [algo-011](../practice/live-coding/03-algorithms.md#algo-011), [algo-012](../practice/live-coding/03-algorithms.md#algo-012), [algo-013](../practice/live-coding/03-algorithms.md#algo-013), [algo-014](../practice/live-coding/03-algorithms.md#algo-014), [algo-015](../practice/live-coding/03-algorithms.md#algo-015), [algo-047](../practice/live-coding/03-algorithms.md#algo-047)

## Sliding window
The window is `s[left..right]`. Move `right` forward every step; move `left` forward while the window is invalid (variable size) or by exactly one (fixed size k). Both pointers only move forward, so the nested `while` is still O(n) in total. Validity must be monotonic: shrinking a valid window keeps it valid. Sums with negative numbers break this; use prefix sums instead.
```ts
// Longest window with no repeated char: jump left past the previous occurrence
function lengthOfLongestSubstring(s: string): number {
  const last = new Map<string, number>();
  let left = 0, best = 0;
  for (let right = 0; right < s.length; right++) {
    const prev = last.get(s[right]);
    if (prev !== undefined && prev >= left) left = prev + 1;   // only jump forward
    last.set(s[right], right);
    best = Math.max(best, right - left + 1);
  }
  return best;                                                 // 'abcabcbb' → 3, 'abba' → 2
}
// "Replace up to k chars": a window is valid iff length − (count of its most frequent letter) ≤ k
function characterReplacement(s: string, k: number): number {
  const cnt = new Array<number>(26).fill(0);
  let left = 0, maxFreq = 0, best = 0;
  for (let right = 0; right < s.length; right++) {
    maxFreq = Math.max(maxFreq, ++cnt[s.charCodeAt(right) - 65]);
    while (right - left + 1 - maxFreq > k) cnt[s.charCodeAt(left++) - 65]--;
    best = Math.max(best, right - left + 1);
  }
  return best;                                                 // ('AABABBA', 1) → 4
}
// Shortest window covering t: counts of what is still needed + one `missing` counter
function minWindow(s: string, t: string): string {
  const need = new Map<string, number>();
  for (const ch of t) need.set(ch, (need.get(ch) ?? 0) + 1);
  let missing = t.length, left = 0, bestL = 0, bestLen = Infinity;
  for (let right = 0; right < s.length; right++) {
    const c = need.get(s[right]);
    if (c !== undefined) { if (c > 0) missing--; need.set(s[right], c - 1); } // negative = surplus
    while (missing === 0) {
      if (right - left + 1 < bestLen) { bestL = left; bestLen = right - left + 1; }
      const d = need.get(s[left]);
      if (d !== undefined) { if (d === 0) missing++; need.set(s[left], d + 1); }
      left++;
    }
  }
  return bestLen === Infinity ? '' : s.slice(bestL, bestL + bestLen); // ('ADOBECODEBANC','ABC') → 'BANC'
}
// Fixed size: one char enters, one leaves; track how many letters differ from the target counts
function findAnagrams(s: string, p: string): number[] {
  const diff = new Array<number>(26).fill(0);                  // window count − p count
  for (const ch of p) diff[ch.charCodeAt(0) - 97]--;
  let nonZero = diff.filter(x => x !== 0).length;
  const bump = (i: number, d: number) => {
    const c = s.charCodeAt(i) - 97;
    if (diff[c] === 0) nonZero++;
    diff[c] += d;
    if (diff[c] === 0) nonZero--;
  };
  const res: number[] = [];
  for (let i = 0; i < s.length; i++) {
    bump(i, 1);
    if (i >= p.length) bump(i - p.length, -1);
    if (i >= p.length - 1 && nonZero === 0) res.push(i - p.length + 1);
  }
  return res;                                                  // ('cbaebabacd','abc') → [0, 6]; "permutation in string" = length > 0
}
```
- **maxFreq never decreases** in the replace-k window: a stale, too-high value can only keep the window the same size, and the answer grows only when a real higher count appears.
- **Min so far** is the degenerate window (best single buy/sell): keep the lowest price seen; profit = price − min. Never global max − global min (you cannot sell before buying).
- **At most k distinct:** count map; while it has more than k keys, shrink and delete keys that reach 0.
- **Fixed window sum/max:** add `x[i]`, subtract `x[i − k]`; for the window *maximum* use the monotonic deque below.

**Cost:** O(n) time, O(alphabet) space. **Trap:** jumping `left` backwards (`'abba'`); recomputing counts per window (O(n·k)).
Drills: [algo-016](../practice/live-coding/03-algorithms.md#algo-016), [algo-017](../practice/live-coding/03-algorithms.md#algo-017), [algo-018](../practice/live-coding/03-algorithms.md#algo-018), [algo-019](../practice/live-coding/03-algorithms.md#algo-019), [algo-020](../practice/live-coding/03-algorithms.md#algo-020), [algo-050](../practice/live-coding/03-algorithms.md#algo-050)

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SLIDING_WINDOW`](../../packages/backend/libs/infrastructure/rate-limit/lua.ts#L49): SLIDING_WINDOW keeps a weighted estimate across fixed time windows to rate-limit requests. _(lua.ts)_
> - [`RetryBudget`](../../packages/backend/libs/infrastructure/http-client/retry-budget.ts#L7): RetryBudget limits retries to a fraction of recent requests using a sliding time window. _(retry-budget.ts)_
<!-- theory-links:end -->

## Prefix sums and prefix/suffix passes
**When:** many range-sum queries; count subarrays with sum k (negatives allowed); each index needs a summary of everything to its left and right.
`prefix[i]` = sum of the first i elements (length n + 1, `prefix[0] = 0`), so `sum(l..r) = prefix[r + 1] − prefix[l]` and the leading 0 removes the `l === 0` special case.
```ts
function prefixSums(nums: number[]): number[] {
  const p = new Array<number>(nums.length + 1).fill(0);
  for (let i = 0; i < nums.length; i++) p[i + 1] = p[i] + nums[i];
  return p;                                                    // range sum l..r = p[r + 1] - p[l], O(1) per query
}
// Count subarrays summing to k: a subarray ending here works iff an earlier prefix equals sum − k
function subarraySum(nums: number[], k: number): number {
  const count = new Map<number, number>([[0, 1]]);             // empty prefix, for subarrays starting at 0
  let sum = 0, res = 0;
  for (const x of nums) {
    sum += x;
    res += count.get(sum - k) ?? 0;
    count.set(sum, (count.get(sum) ?? 0) + 1);
  }
  return res;
}
// Prefix/suffix pass: answer[i] = f(everything left) ⊗ f(everything right), no division
function productExceptSelf(nums: number[]): number[] {
  const out = new Array<number>(nums.length).fill(1);
  for (let i = 1; i < nums.length; i++) out[i] = out[i - 1] * nums[i - 1];   // prefix products
  for (let i = nums.length - 1, suffix = 1; i >= 0; i--) { out[i] *= suffix; suffix *= nums[i]; }
  return out;                                                  // [1,2,3,4] → [24,12,8,6]
}
```
The same left/right idea gives prefix-max and suffix-max arrays (rain water in O(n) space). On a tree, keep a map of prefix sums along the root path and remove the current sum when backtracking (path sum from any node downward). Point updates plus range queries need a Fenwick or segment tree (O(log n) each).
**Cost:** O(n) build. **Trap:** forgetting the `{0: 1}` seed; a sliding window instead (fails with negatives); dividing the total product (breaks on zeros).
Drills: [algo-006](../practice/live-coding/03-algorithms.md#algo-006), [algo-043](../practice/live-coding/03-algorithms.md#algo-043), [algo-044](../practice/live-coding/03-algorithms.md#algo-044)

## Stack
**When:** nesting and matching ("the most recent unmatched thing"), postfix evaluation, undo.
```ts
function isValidBrackets(s: string): boolean {
  const pair: Record<string, string> = { ')': '(', ']': '[', '}': '{' }, st: string[] = [];
  for (const ch of s) {
    if (!(ch in pair)) st.push(ch);
    else if (st.pop() !== pair[ch]) return false;            // also catches a closer on an empty stack
  }
  return st.length === 0;                                    // leftover openers → invalid
}
// Reverse Polish notation: numbers push; an operator pops right THEN left
function evalRPN(tokens: string[]): number {
  const st: number[] = [];
  for (const t of tokens) {
    if (t === '+' || t === '-' || t === '*' || t === '/') {
      const b = st.pop()!, a = st.pop()!;
      st.push(t === '+' ? a + b : t === '-' ? a - b : t === '*' ? a * b : Math.trunc(a / b));
    } else st.push(Number(t));                               // "-3" is a number token
  }
  return st[0];                                              // ['4','13','5','/','+'] → 6
}
// Min stack: a parallel stack holds the minimum up to each depth, so all ops are O(1)
class MinStack {
  private vals: number[] = [];
  private mins: number[] = [];
  push(v: number) { this.vals.push(v); this.mins.push(Math.min(v, this.mins.at(-1) ?? Infinity)); }
  pop() { this.vals.pop(); this.mins.pop(); }
  top() { return this.vals.at(-1); }
  getMin() { return this.mins.at(-1); }
}
```
**Cost:** O(n) / O(n). **Trap:** a single "current min" variable breaks after popping the min; RPN division must truncate toward zero (`-7/2 → -3`), not floor. One bracket type needs only a counter. Infix expressions: convert to RPN with shunting-yard (operator stack with precedence).
Drills: [algo-022](../practice/live-coding/03-algorithms.md#algo-022), [algo-023](../practice/live-coding/03-algorithms.md#algo-023), [algo-024](../practice/live-coding/03-algorithms.md#algo-024)

## Monotonic stack and deque
A monotonic stack holds indices whose values stay sorted. A new element pops every element it "beats", and the pop is the moment that element's answer becomes known. Each index is pushed and popped once, so O(n). Store indices, not values: you need distances and window expiry.
```ts
// Next greater: decreasing stack. "Days until warmer" = i − popped index.
function nextGreater(nums: number[]): number[] {
  const res = new Array<number>(nums.length).fill(-1);
  const st: number[] = [];                                   // indices, values decreasing
  for (let i = 0; i < nums.length; i++) {
    while (st.length && nums[st[st.length - 1]] < nums[i]) res[st.pop()!] = nums[i];
    st.push(i);
  }
  return res;                                                // [2,1,2,4,3] → [4,2,4,-1,-1]
}
// Largest rectangle: increasing stack; a popped bar spans (new top, i). Sentinel 0 flushes the rest.
function largestRectangle(h: number[]): number {
  const st: number[] = []; let best = 0;
  for (let i = 0; i <= h.length; i++) {
    const cur = i === h.length ? 0 : h[i];
    while (st.length && h[st[st.length - 1]] >= cur) {
      const height = h[st.pop()!];
      const left = st.length ? st[st.length - 1] : -1;
      best = Math.max(best, height * (i - left - 1));
    }
    st.push(i);
  }
  return best;                                               // [2,1,5,6,2,3] → 10
}
// Sliding window maximum: deque of indices with decreasing values; the front is the max
function maxSlidingWindow(nums: number[], k: number): number[] {
  const dq: number[] = []; let head = 0;                     // head index instead of O(n) shift()
  const res: number[] = [];
  for (let i = 0; i < nums.length; i++) {
    while (dq.length > head && nums[dq[dq.length - 1]] <= nums[i]) dq.pop(); // smaller ones can never be max again
    dq.push(i);
    if (dq[head] <= i - k) head++;                           // front slid out of the window
    if (i >= k - 1) res.push(nums[dq[head]]);
  }
  return res;                                                // ([1,3,-1,-3,5,3,6,7], 3) → [3,3,5,5,6,7]
}
```
Circular input: loop i over `0..2n−1` with `i % n` and push only during the first pass. A row-by-row histogram turns "maximal rectangle of 1s" into this problem.
**Cost:** O(n) / O(n). **Trap:** wrong comparison direction (decreasing stack for next *greater*); forgetting the sentinel.
Drills: [algo-021](../practice/live-coding/03-algorithms.md#algo-021), [algo-025](../practice/live-coding/03-algorithms.md#algo-025), [algo-026](../practice/live-coding/03-algorithms.md#algo-026) ([algo-014](../practice/live-coding/03-algorithms.md#algo-014) can also be solved with a decreasing stack)

## Binary search
Keep an invariant about where the answer can still be, and halve that range every step.
- **Exact match:** inclusive `[lo, hi]`, `while (lo <= hi)`, always move past mid (`mid ± 1`).
- **Boundary (lower bound):** half-open `[lo, hi)`, `while (lo < hi)`, `hi = mid` when the predicate holds. Finds the first index where a monotonic predicate becomes true; this is also the insert position.
- **First/last occurrence:** `lowerBound(t)` and `lowerBound(t + 1) − 1` (integers); count = last − first + 1.
- **Sorted matrix** (each row continues the previous one): search virtual indices `0..m·n−1`, cell = `[i / cols | 0, i % cols]`. Rows and columns sorted only independently → walk from the top-right corner, O(m + n).
- **On the answer:** if "x works" implies "x + 1 works", search the smallest x that works over the answer range; each check is O(n).
- **Rotated sorted array:** one half around `mid` is always sorted.
```ts
function binarySearch(a: number[], t: number): number {
  let lo = 0, hi = a.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] === t) return mid;
    if (a[mid] < t) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}
function lowerBound(arr: number[], target: number): number {   // first index with arr[i] >= target
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}
function searchRange(a: number[], t: number): [number, number] {
  const first = lowerBound(a, t);
  return first < a.length && a[first] === t ? [first, lowerBound(a, t + 1) - 1] : [-1, -1];
}
// On the answer: min ship capacity to ship all packages within `days` (Koko's eating speed is the same shape)
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
// Rotated: compare with the RIGHT end. nums[mid] > nums[hi] → the drop (minimum) is right of mid.
function findMinRotated(nums: number[]): number {
  let lo = 0, hi = nums.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (nums[mid] > nums[hi]) lo = mid + 1; else hi = mid;
  }
  return nums[lo];                                             // [4,5,6,7,0,1,2] → 0
}
function searchRotated(nums: number[], t: number): number {
  let lo = 0, hi = nums.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (nums[mid] === t) return mid;
    if (nums[lo] <= nums[mid]) {                               // left half sorted (<= covers lo === mid)
      if (nums[lo] <= t && t < nums[mid]) hi = mid - 1; else lo = mid + 1;
    } else {                                                   // right half sorted
      if (nums[mid] < t && t <= nums[hi]) lo = mid + 1; else hi = mid - 1;
    }
  }
  return -1;                                                   // ([4,5,6,7,0,1,2], 0) → 4
}
```
**Cost:** O(log n) (on the answer: O(n log range)). **Trap:** mixing the two loop forms (`lo < hi` with `hi = mid - 1` skips answers, `lo = mid` loops forever); comparing with `nums[lo]` when finding the rotated minimum fails on an unrotated array; with duplicates, `nums[mid] === nums[hi]` → `hi--` (worst case O(n)).
Drills: [algo-027](../practice/live-coding/03-algorithms.md#algo-027), [algo-028](../practice/live-coding/03-algorithms.md#algo-028), [algo-029](../practice/live-coding/03-algorithms.md#algo-029), [algo-030](../practice/live-coding/03-algorithms.md#algo-030), [algo-031](../practice/live-coding/03-algorithms.md#algo-031), [algo-032](../practice/live-coding/03-algorithms.md#algo-032) (lower bound also drives [algo-085](../practice/live-coding/03-algorithms.md#algo-085))

## Linked lists
Pointer rewiring in O(1) space. Draw the three nodes `prev → curr → next` before writing code.
- **Dummy head:** a fake node before the head removes the "is it the head?" special case (merge, remove, insert).
- **Reverse:** save `next`, point `curr.next` back to `prev`, advance.
- **Fast/slow:** fast moves 2, slow moves 1. When fast ends, slow is at the middle. If they meet, there is a cycle (Floyd); then restart one pointer at head and step both by 1: they meet at the cycle start.
- **Gap:** move `fast` n + 1 steps ahead of `slow` (from the dummy); when fast is null, `slow.next` is the n-th node from the end.
- **Composite (reorder, palindrome check):** middle → reverse second half → merge or compare. Cut the first half (`slow.next = null`) or you create a cycle.
- **Digit lists:** add digit by digit with a carry; loop while either list *or the carry* remains. Never convert to a number (precision past 2^53).
```ts
type ListNode = { val: number; next: ListNode | null };
function reverseList(head: ListNode | null): ListNode | null {
  let prev: ListNode | null = null, curr = head;
  while (curr) { const next = curr.next; curr.next = prev; prev = curr; curr = next; }
  return prev;
}
function mergeTwo(a: ListNode | null, b: ListNode | null): ListNode | null {
  const dummy: ListNode = { val: 0, next: null }; let tail = dummy;
  while (a && b) {
    if (a.val <= b.val) { tail.next = a; a = a.next; } else { tail.next = b; b = b.next; }
    tail = tail.next;
  }
  tail.next = a ?? b;                                        // attach the leftover in one step
  return dummy.next;
}
function middle(head: ListNode | null): ListNode | null {    // second middle for even length
  let slow = head, fast = head;
  while (fast && fast.next) { slow = slow!.next; fast = fast.next.next; }
  return slow;
}
function hasCycle(head: ListNode | null): boolean {
  let slow = head, fast = head;
  while (fast && fast.next) { slow = slow!.next; fast = fast.next.next; if (slow === fast) return true; } // compare identity, not val
  return false;
}
function removeNthFromEnd(head: ListNode | null, n: number): ListNode | null {
  const dummy: ListNode = { val: 0, next: head };
  let fast: ListNode | null = dummy, slow: ListNode = dummy;
  for (let i = 0; i <= n; i++) fast = fast!.next;            // gap of n + 1
  while (fast) { fast = fast.next; slow = slow.next!; }
  slow.next = slow.next!.next;
  return dummy.next;
}
function reorderList(head: ListNode | null): void {          // L0 → Ln → L1 → Ln-1 → ...
  if (!head) return;
  let slow = head, fast = head;
  while (fast.next && fast.next.next) { slow = slow.next!; fast = fast.next.next; }
  let b = reverseList(slow.next); slow.next = null;          // cut, then reverse the second half
  let a: ListNode | null = head;
  while (a && b) { const an: ListNode | null = a.next, bn: ListNode | null = b.next; a.next = b; b.next = an; a = an; b = bn; }
}
```
**Cost:** O(n) / O(1) (recursive reverse uses O(n) stack). **Trap:** losing the rest of the list by not saving `next`; not handling removal of the head (use the dummy). k sorted lists: see Heap.
Drills: [algo-033](../practice/live-coding/03-algorithms.md#algo-033), [algo-034](../practice/live-coding/03-algorithms.md#algo-034), [algo-035](../practice/live-coding/03-algorithms.md#algo-035), [algo-036](../practice/live-coding/03-algorithms.md#algo-036), [algo-037](../practice/live-coding/03-algorithms.md#algo-037), [algo-038](../practice/live-coding/03-algorithms.md#algo-038)

## Intervals
**When:** overlaps, merging, scheduling, minimum resources or removals. Sort first, then one pass.
- **Merge:** sort by start; an overlapping interval must come right after the current block, so extend it with `max(end)` or start a new block.
- **Insert into a sorted, disjoint list:** three phases, O(n) and no sort: copy the ones ending before the new start, absorb overlaps (widen start/end), copy the rest.
- **Most intervals kept / fewest removed / fewest arrows:** greedy by **earliest end**: sort by end, keep an interval if it starts at or after the last kept end. Removals = n − kept.
- **Max overlap at any time (rooms):** sweep sorted starts against sorted ends, or sort by start and keep a min-heap of end times; the heap size is the room count.
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
function insertInterval(iv: [number, number][], nw: [number, number]): [number, number][] {
  const res: [number, number][] = []; let [s, e] = nw, i = 0;
  while (i < iv.length && iv[i][1] < s) res.push(iv[i++]);
  while (i < iv.length && iv[i][0] <= e) { s = Math.min(s, iv[i][0]); e = Math.max(e, iv[i][1]); i++; }
  res.push([s, e]);
  while (i < iv.length) res.push(iv[i++]);
  return res;                                                // ([[1,3],[6,9]], [2,5]) → [[1,5],[6,9]]
}
function eraseOverlapIntervals(iv: [number, number][]): number {
  const s = [...iv].sort((a, b) => a[1] - b[1]);
  let kept = 0, end = -Infinity;
  for (const [a, b] of s) if (a >= end) { kept++; end = b; }
  return iv.length - kept;                                   // [[1,2],[2,3],[3,4],[1,3]] → 1
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
**Cost:** O(n log n) for the sort, O(n) output. **Trap:** extending with the new end instead of `max` (a contained interval shrinks the block); decide whether touching intervals overlap (`[1,2]` and `[2,3]`: back-to-back meetings share a room, so `ends[e] <= s` frees it); sorting by start for the "keep most" greedy.
Drills: [algo-039](../practice/live-coding/03-algorithms.md#algo-039), [algo-040](../practice/live-coding/03-algorithms.md#algo-040), [algo-041](../practice/live-coding/03-algorithms.md#algo-041), [algo-042](../practice/live-coding/03-algorithms.md#algo-042)

## Trees
```ts
type TreeNode = { val: number; left: TreeNode | null; right: TreeNode | null };
```
- **DFS (recursion):** compute a node's answer from its children's answers (post-order): depth = 1 + max(children); same tree = values equal and both child pairs equal (walk both trees in lockstep); invert = swap children; subtree = "same tree" tried at every node (O(m·n)). Pass state *down* as a parameter (remaining target, allowed range) and check path conditions only at leaves.
- **Return one thing, record another:** the DFS returns height, and a global records the best path that bends at the node (`leftH + rightH`). The diameter need not pass through the root. Max path sum uses the same shape with gains clamped at 0.
- **BFS by level:** take a snapshot of the queue length (or build a next-level array) so each level is grouped.
- **BST:** every node lies in an open range `(low, high)` inherited from its ancestors; in-order traversal is sorted; to find where two values split, walk down: both smaller → left, both larger → right, otherwise here.
```ts
const maxDepth = (n: TreeNode | null): number => n ? 1 + Math.max(maxDepth(n.left), maxDepth(n.right)) : 0;
function levelOrder(root: TreeNode | null): number[][] {
  const res: number[][] = []; let level = root ? [root] : [];
  while (level.length) {
    res.push(level.map(n => n.val));
    const next: TreeNode[] = [];
    for (const n of level) { if (n.left) next.push(n.left); if (n.right) next.push(n.right); }
    level = next;                                            // no shift(): swap level arrays
  }
  return res;
}
function diameter(root: TreeNode | null): number {           // in edges
  let best = 0;
  const height = (n: TreeNode | null): number => {
    if (!n) return 0;
    const l = height(n.left), r = height(n.right);
    best = Math.max(best, l + r);                            // path bending here
    return 1 + Math.max(l, r);                               // what the parent can extend
  };
  height(root);
  return best;
}
function isValidBST(n: TreeNode | null, low = -Infinity, high = Infinity): boolean {
  if (!n) return true;
  if (n.val <= low || n.val >= high) return false;
  return isValidBST(n.left, low, n.val) && isValidBST(n.right, n.val, high);
}
function kthSmallest(root: TreeNode | null, k: number): number {  // iterative in-order, stops early
  const st: TreeNode[] = []; let n = root;
  for (;;) {
    while (n) { st.push(n); n = n.left; }
    n = st.pop()!;
    if (--k === 0) return n.val;                             // k is 1-indexed
    n = n.right;
  }
}
function lcaBST(root: TreeNode, p: number, q: number): TreeNode {
  let n = root;
  for (;;) {
    if (p < n.val && q < n.val) n = n.left!;
    else if (p > n.val && q > n.val) n = n.right!;
    else return n;                                           // split point; a node can be its own ancestor
  }
}
```
Plain binary tree LCA: return the node if it is p or q; if both recursive calls return non-null, the current node is the LCA, otherwise pass up the non-null side.
**Cost:** O(n) time, O(h) stack (h = height: log n balanced, n skewed); BST walks O(h). **Trap:** checking only a node's direct children for BST validity; a node with one child is not a leaf; an empty tree; recursion past ~10k levels overflows the stack, so switch to an explicit stack or BFS.
Drills: [algo-051](../practice/live-coding/03-algorithms.md#algo-051), [algo-052](../practice/live-coding/03-algorithms.md#algo-052), [algo-053](../practice/live-coding/03-algorithms.md#algo-053), [algo-054](../practice/live-coding/03-algorithms.md#algo-054), [algo-055](../practice/live-coding/03-algorithms.md#algo-055), [algo-056](../practice/live-coding/03-algorithms.md#algo-056), [algo-057](../practice/live-coding/03-algorithms.md#algo-057), [algo-058](../practice/live-coding/03-algorithms.md#algo-058), [algo-059](../practice/live-coding/03-algorithms.md#algo-059), [algo-060](../practice/live-coding/03-algorithms.md#algo-060)

## Heap (JS has none, so memorize this)
A binary heap keeps the smallest element (by `cmp`) at the root: push and pop are O(log n), peek is O(1). For a max-heap, flip the comparator.
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

// k-th largest: min-heap capped at k holds the k largest; its root is the answer. O(n log k)
function kthLargest(nums: number[], k: number): number {
  const h = new MinHeap<number>((a, b) => a - b);
  for (const x of nums) { h.push(x); if (h.size > k) h.pop(); }
  return h.peek()!;                                          // ([3,2,1,5,6,4], 2) → 5
}
// Top-k frequent with a size-k heap: O(n log k)
function topKFrequent(nums: number[], k: number): number[] {
  const freq = new Map<number, number>();
  for (const x of nums) freq.set(x, (freq.get(x) ?? 0) + 1);
  const h = new MinHeap<[number, number]>((a, b) => a[1] - b[1]);
  for (const e of freq) { h.push(e); if (h.size > k) h.pop(); }
  const res: number[] = []; while (h.size) res.push(h.pop()![0]);
  return res.reverse();
}
// Top-k frequent with bucket sort: a frequency is at most n, so index buckets by it. O(n)
function topKFrequentBuckets(nums: number[], k: number): number[] {
  const freq = new Map<number, number>();
  for (const x of nums) freq.set(x, (freq.get(x) ?? 0) + 1);
  const buckets: number[][] = Array.from({ length: nums.length + 1 }, () => []);
  for (const [x, f] of freq) buckets[f].push(x);
  const res: number[] = [];
  for (let f = nums.length; f > 0 && res.length < k; f--) res.push(...buckets[f]);
  return res.slice(0, k);                                    // ([1,1,1,2,2,3], 2) → [1,2]
}
// Running median with two heaps: low = max-heap of the smaller half, high = min-heap of the larger half
class MedianFinder {
  private low = new MinHeap<number>((a, b) => b - a);
  private high = new MinHeap<number>((a, b) => a - b);
  add(x: number) {
    this.low.push(x); this.high.push(this.low.pop()!);       // route through low so every low ≤ every high
    if (this.high.size > this.low.size) this.low.push(this.high.pop()!); // low has the same size or one more
  }
  median(): number {
    return this.low.size > this.high.size ? this.low.peek()! : (this.low.peek()! + this.high.peek()!) / 2;
  }
}
// Cooldown scheduling: the most frequent task fixes the frame; other tasks fill the gaps
function leastInterval(tasks: string[], n: number): number {
  const cnt = [...counts(tasks).values()], max = Math.max(...cnt);
  const ties = cnt.filter(c => c === max).length;
  return Math.max(tasks.length, (max - 1) * (n + 1) + ties);  // (['A','A','A','B','B','B'], 2) → 8
}
```
- **K closest / k smallest:** the mirror image: a *max*-heap of size k, evict the farthest. Compare squared distances (no `Math.sqrt`).
- **Merge k sorted lists:** heap of the current head of each list; pop the smallest, push its successor. O(N log k). Without a heap: merge pairs in rounds, also O(N log k).
- **Quickselect** (partition around a random pivot, recurse into one side) gives k-th largest in O(n) average, O(n²) worst.
- **Scheduling with a real order:** max-heap of remaining counts plus a queue of tasks cooling down.

**Cost:** O(log n) per op; top-k O(n log k). **Trap:** a max-heap of all n elements (O(n) memory) when a size-k heap suffices; pushing an empty list's head; in the two-heap median, pushing straight into one heap breaks the ordering between halves; forgetting `tasks.length` as the lower bound.
Drills: [algo-005](../practice/live-coding/03-algorithms.md#algo-005), [algo-061](../practice/live-coding/03-algorithms.md#algo-061), [algo-062](../practice/live-coding/03-algorithms.md#algo-062), [algo-063](../practice/live-coding/03-algorithms.md#algo-063), [algo-064](../practice/live-coding/03-algorithms.md#algo-064), [algo-065](../practice/live-coding/03-algorithms.md#algo-065)

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TopK`](../../packages/backend/libs/domains/discovery/domain/count-min-sketch.ts#L41): TopK is a min-heap that tracks the K largest frequency estimates. _(count-min-sketch.ts)_
<!-- theory-links:end -->

## Graph traversal: grids, clones, implicit graphs
BFS visits nodes in order of distance, so the first time it reaches a node is a shortest path in an *unweighted* graph. Use an index pointer as the queue, since `shift()` is O(n). Mark a node visited **when you push it**, not when you pop it, or the same node is queued many times.
- **Grid flood fill:** each unvisited land cell starts a component; BFS/DFS marks all connected land. For the area, count cells during the fill.
- **Multi-source BFS:** seed the queue with *every* source at distance 0 (all rotten oranges, all gates), then expand level by level; each level is one time step.
- **Implicit graph:** generate neighbours on the fly (word ladder: change each position to each letter, look it up in a Set; delete from the Set when enqueued). Bidirectional BFS (grow the smaller frontier) cuts the search space.
- **Clone / deep copy:** map original → copy; put the copy in the map *before* visiting neighbours, so cycles reuse it instead of recursing forever (same for lists with random pointers).
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
// Multi-source BFS by levels: minutes until every fresh orange (1) is rotten (2), or -1
function orangesRotting(grid: number[][]): number {
  let level: [number, number][] = [], fresh = 0, minutes = 0;
  grid.forEach((row, r) => row.forEach((v, c) => { if (v === 2) level.push([r, c]); else if (v === 1) fresh++; }));
  while (level.length && fresh > 0) {                        // stop when nothing is left to rot
    const next: [number, number][] = [];
    for (const [r, c] of level)
      for (const [nr, nc] of [[r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]])
        if (grid[nr]?.[nc] === 1) { grid[nr][nc] = 2; fresh--; next.push([nr, nc]); }
    level = next; minutes++;
  }
  return fresh === 0 ? minutes : -1;                         // [[2,1,1],[1,1,0],[0,1,1]] → 4
}
// BFS on an implicit graph: the answer counts words, so start at 1
function ladderLength(begin: string, end: string, words: string[]): number {
  const dict = new Set(words);
  if (!dict.has(end)) return 0;
  let level = [begin], steps = 1; dict.delete(begin);
  while (level.length) {
    const next: string[] = [];
    for (const w of level) {
      if (w === end) return steps;
      for (let i = 0; i < w.length; i++)
        for (let c = 97; c <= 122; c++) {
          const cand = w.slice(0, i) + String.fromCharCode(c) + w.slice(i + 1);
          if (dict.has(cand)) { dict.delete(cand); next.push(cand); }
        }
    }
    level = next; steps++;
  }
  return 0;                                                  // ('hit','cog',['hot','dot','dog','lot','log','cog']) → 5
}
type GraphNode = { val: number; neighbors: GraphNode[] };
function cloneGraph(node: GraphNode | null): GraphNode | null {
  const copies = new Map<GraphNode, GraphNode>();
  const dfs = (n: GraphNode): GraphNode => {
    let c = copies.get(n);
    if (c) return c;
    c = { val: n.val, neighbors: [] }; copies.set(n, c);      // register BEFORE recursing
    for (const nb of n.neighbors) c.neighbors.push(dfs(nb));
    return c;
  };
  return node && dfs(node);
}
```
**Cost:** O(V + E) (grid: O(R·C)); word ladder O(N·L²·26). **Trap:** marking on pop; for multi-source BFS, starting a separate BFS per source (O((R·C)²)); counting an extra minute after the last level; using BFS on a weighted graph (use Dijkstra).
Drills: [algo-066](../practice/live-coding/03-algorithms.md#algo-066), [algo-067](../practice/live-coding/03-algorithms.md#algo-067), [algo-068](../practice/live-coding/03-algorithms.md#algo-068), [algo-071](../practice/live-coding/03-algorithms.md#algo-071), [algo-074](../practice/live-coding/03-algorithms.md#algo-074)

## Topological sort (Kahn) + cycle detection
**When:** tasks with prerequisites; "can all be finished?" = "is the directed graph acyclic?". Repeatedly remove nodes with in-degree 0 (no unmet prerequisites); nodes on a cycle never reach 0.
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
DFS alternative: three colours (0 unvisited, 1 on the current path, 2 done); reaching a colour-1 node is a cycle; the reversed post-order is a valid order. Minimum number of rounds (semesters) = number of BFS layers in Kahn.
**Cost:** O(V + E). **Trap:** edge direction must be prerequisite → course (`[course, pre]` input gives the edge `pre → course`), otherwise the order comes out reversed.
Drills: [algo-069](../practice/live-coding/03-algorithms.md#algo-069), [algo-070](../practice/live-coding/03-algorithms.md#algo-070)

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`topoSort`](../../packages/backend/libs/domains/media/domain/dag.ts#L15): topoSort runs Kahn's algorithm and throws an error naming the cycle nodes when it finds one. _(dag.ts)_
> - [`readyTasks`](../../packages/backend/libs/domains/media/domain/dag.ts#L36): readyTasks returns the tasks whose dependencies are satisfied, which is the zero in-degree frontier. _(dag.ts)_
> - [`videoPipeline`](../../packages/backend/libs/domains/media/domain/dag.ts#L42): videoPipeline builds the probe → (renditions ‖ poster) → package → publish DAG that topoSort orders. _(dag.ts)_
<!-- theory-links:end -->

## Dijkstra
**When:** shortest paths from one source with non-negative edge weights. Always finalize the closest unfinalized node (min-heap of `[dist, node]`).
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
// "Time for a signal to reach all nodes" = max(dist), or -1 if some dist is Infinity
```
**Cost:** O((V + E) log V). **Trap:** plain BFS with weights; not skipping stale entries; negative weights need Bellman-Ford (relax all edges V − 1 times, O(V·E)).
Drills: [algo-072](../practice/live-coding/03-algorithms.md#algo-072)

## Union-Find (path compression + union by rank)
**When:** components that only merge; "are a and b connected?"; cycle in an undirected graph; components appearing online (islands added one by one).
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
// Components = n − (number of unions that returned true). Valid tree ⇔ edges = n − 1 and no union returns false.
```
**Cost:** ~O(α(n)) per op. **Trap:** decrementing the component count for an edge inside one component. DFS/BFS over an adjacency list is an equally good O(V + E) answer for a static graph.
Drills: [algo-073](../practice/live-coding/03-algorithms.md#algo-073)

## Backtracking
**When:** "all" subsets / permutations / combinations / boards; n is small (≤ ~20). Build a candidate step by step: **choose → recurse → undo**, and prune branches that cannot succeed.
```ts
function subsets(nums: number[]): number[][] {
  const res: number[][] = [], cur: number[] = [];
  const bt = (i: number) => {
    if (i === nums.length) { res.push([...cur]); return; }   // push a COPY
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
// Combinations: loop from `start` so each set is built in one order only.
// Recurse with i (reuse allowed) or i + 1 (each item once); sorting allows `break` once too big.
function combinationSum(cands: number[], target: number): number[][] {
  const c = [...cands].sort((a, b) => a - b), res: number[][] = [], cur: number[] = [];
  const bt = (start: number, rem: number) => {
    if (rem === 0) { res.push([...cur]); return; }
    for (let i = start; i < c.length && c[i] <= rem; i++) { cur.push(c[i]); bt(i, rem - c[i]); cur.pop(); }
  };
  bt(0, target);
  return res;                                                // ([2,3,6,7], 7) → [[2,2,3],[7]]
}
// Constraint pruning: only ever build valid prefixes
function generateParens(n: number): string[] {
  const res: string[] = [];
  const bt = (s: string, open: number, close: number) => {
    if (s.length === 2 * n) { res.push(s); return; }
    if (open < n) bt(s + '(', open + 1, close);
    if (close < open) bt(s + ')', open, close + 1);
  };
  bt('', 0, 0);
  return res;                                                // 3 → 5 strings (Catalan number)
}
// Grid path: mark the cell for the current path, restore it on the way back
function exist(board: string[][], word: string): boolean {
  const R = board.length, C = board[0].length;
  const dfs = (r: number, c: number, i: number): boolean => {
    if (i === word.length) return true;
    if (r < 0 || c < 0 || r >= R || c >= C || board[r][c] !== word[i]) return false;
    const ch = board[r][c]; board[r][c] = '#';
    const ok = dfs(r + 1, c, i + 1) || dfs(r - 1, c, i + 1) || dfs(r, c + 1, i + 1) || dfs(r, c - 1, i + 1);
    board[r][c] = ch;
    return ok;
  };
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (dfs(r, c, 0)) return true;
  return false;
}
```
- **One level per input position:** phone-letter combinations recurse over digits and branch over each digit's letters; the empty input returns `[]`, not `['']`.
- **Duplicates in the input:** sort, then skip `nums[i]` when `i > start && nums[i] === nums[i - 1]` (same value twice at one depth). For permutations: skip when `nums[i] === nums[i − 1]` and `nums[i − 1]` is not used.
- **Many words on one board:** put them in a trie and walk it alongside the DFS.

**Cost:** subsets O(n·2ⁿ), permutations O(n·n!), grid word search O(R·C·3^L). **Trap:** pushing `cur` instead of a copy; forgetting to undo (`used[i]`, the board cell); recursing with 0 instead of `i` in combinations (produces permutations of one combination).
Drills: [algo-075](../practice/live-coding/03-algorithms.md#algo-075), [algo-076](../practice/live-coding/03-algorithms.md#algo-076), [algo-077](../practice/live-coding/03-algorithms.md#algo-077), [algo-078](../practice/live-coding/03-algorithms.md#algo-078), [algo-079](../practice/live-coding/03-algorithms.md#algo-079), [algo-080](../practice/live-coding/03-algorithms.md#algo-080)

## Greedy
**When:** a locally best choice can be proven never worse than any alternative (exchange argument: swapping it into an optimal answer does not make that answer worse). If you cannot argue it, look for a counterexample and fall back to DP (coins `[1,3,4]`, amount 6: greedy takes 4+1+1, the optimum is 3+3).
```ts
// Reach: track the farthest index reachable so far
function canJump(nums: number[]): boolean {
  let reach = 0;
  for (let i = 0; i < nums.length; i++) {
    if (i > reach) return false;                             // stuck before i
    reach = Math.max(reach, i + nums[i]);
  }
  return true;
}
// Circuit: if the total surplus is ≥ 0 a start exists; when the tank goes negative at i, no start in [start, i] works
function canCompleteCircuit(gas: number[], cost: number[]): number {
  let total = 0, tank = 0, start = 0;
  for (let i = 0; i < gas.length; i++) {
    const d = gas[i] - cost[i]; total += d; tank += d;
    if (tank < 0) { start = i + 1; tank = 0; }
  }
  return total >= 0 ? start : -1;                            // ([1,2,3,4,5], [3,4,5,1,2]) → 3
}
// Unlimited trades: any rise a→b equals the sum of the daily rises in between
const maxProfitUnlimited = (p: number[]) => p.reduce((s, x, i) => s + (i && x > p[i - 1] ? x - p[i - 1] : 0), 0);
```
Other greedy choices in this sheet: earliest end first (Intervals), most frequent task first (Heap). Minimum jumps: BFS by ranges: when `i` reaches the current range end, jumps++ and the end becomes the farthest reach.
**Cost:** O(n) / O(1) (plus a sort if needed). **Trap:** skipping the `total >= 0` check in the circuit; a transaction fee or cooldown breaks the "sum of rises" greedy (use the state-machine DP).
Drills: [algo-041](../practice/live-coding/03-algorithms.md#algo-041), [algo-065](../practice/live-coding/03-algorithms.md#algo-065), [algo-093](../practice/live-coding/03-algorithms.md#algo-093), [algo-094](../practice/live-coding/03-algorithms.md#algo-094), [algo-095](../practice/live-coding/03-algorithms.md#algo-095)

## Dynamic programming
See the [DP doc](02-dynamic-programming.md): method, 1D, knapsack, LIS, two-string and grid DP, each with its drills.

## LRU cache (Map keeps insertion order)
**When:** fixed capacity, evict the least recently used key, O(1) `get`/`put`. A JS `Map` iterates in insertion order: delete + re-set moves a key to the "most recent" end, and `keys().next()` is the least recent.
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
If the interviewer forbids relying on Map order: `Map<key, node>` plus a doubly linked list with dummy head and tail; move a node to the front on access and evict `tail.prev`.
**Cost:** O(1) average per op. **Trap:** `put` on an existing key must refresh its recency and must not evict.
Drills: [algo-100](../practice/live-coding/03-algorithms.md#algo-100)

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`InMemoryTokenBucket`](../../packages/backend/libs/infrastructure/rate-limit/in-memory-token-bucket.ts#L7): InMemoryTokenBucket is a rate limiter with LRU-like eviction and a bounded capacity. _(in-memory-token-bucket.ts)_
<!-- theory-links:end -->

## Trie
**When:** prefix queries, autocomplete, wildcard word search, many words searched together. A trie is a tree where each edge is a character and a word is a root-to-node path ending at a node marked `end`.
```ts
class TrieNode { children = new Map<string, TrieNode>(); end = false; }
class Trie {
  root = new TrieNode();
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
// Wildcard '.': a normal char follows one child, '.' branches into every child (DFS)
function matchPattern(n: TrieNode, p: string, i = 0): boolean {
  if (i === p.length) return n.end;                          // a node existing is not enough
  if (p[i] !== '.') { const c = n.children.get(p[i]); return !!c && matchPattern(c, p, i + 1); }
  for (const c of n.children.values()) if (matchPattern(c, p, i + 1)) return true;
  return false;                                              // matchPattern(trie.root, 'b.d')
}
```
Autocomplete: walk to the prefix node, then DFS below it (or store the top-k completions at each node).
**Cost:** O(L) per insert/lookup; wildcard search up to O(26^dots · L); space O(total characters). **Trap:** `search('app')` must be false until "app" itself is inserted.
Drills: [algo-096](../practice/live-coding/03-algorithms.md#algo-096), [algo-097](../practice/live-coding/03-algorithms.md#algo-097)

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TopKTrie`](../../packages/backend/libs/domains/discovery/domain/top-k-trie.ts#L22): TopKTrie is a prefix trie that precomputes top-K completions at each node. _(top-k-trie.ts)_
> - [`normalizeQuery`](../../packages/backend/libs/domains/discovery/domain/top-k-trie.ts#L79): normalizeQuery lowercases and trims queries into the canonical form the trie is keyed on. _(top-k-trie.ts)_
<!-- theory-links:end -->

## Bit tricks
- `x ^ x = 0`, `x ^ 0 = x`, XOR is commutative: XOR everything and pairs cancel, leaving the unpaired value.
- `x & (x − 1)` clears the lowest set bit: loop it to count bits (once per 1 bit); `x > 0 && (x & (x − 1)) === 0` tests for a power of two.
- `bits[i] = bits[i >> 1] + (i & 1)`: i without its last bit is already solved (a DP over numbers).
```ts
const singleNumber = (nums: number[]) => nums.reduce((a, x) => a ^ x, 0);   // [4,1,2,1,2] → 4
function popcount(x: number): number { let c = 0; while (x) { x &= x - 1; c++; } return c; }
function countBits(n: number): number[] {
  const bits = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) bits[i] = bits[i >> 1] + (i & 1);
  return bits;                                               // 5 → [0,1,1,2,1,2]
}
```
**Cost:** O(n) / O(1). **Trap:** JS bitwise operators work on 32-bit *signed* integers: values ≥ 2³¹ turn negative (`x >>> 0` gives the unsigned value), and `popcount` loops forever on non-integers.
Drills: [algo-098](../practice/live-coding/03-algorithms.md#algo-098), [algo-099](../practice/live-coding/03-algorithms.md#algo-099)

---

## Complexity reference
| Structure / op | Time |
|---|---|
| Map/Set get/set/has | O(1) avg |
| Array push/pop | O(1) amortized; `shift`/`unshift`/`splice` O(n) |
| sort | O(n log n) (TimSort in V8, stable) |
| binary search | O(log n) |
| heap push/pop | O(log n); build O(n) |
| trie insert/search | O(L) for a word of length L |
| BFS/DFS | O(V + E) |
| Dijkstra (binary heap) | O((V + E) log V) |
| Union-find (both optimizations) | ~O(α(n)) ≈ O(1) |
| subsets / permutations | O(n·2ⁿ) / O(n·n!) |
