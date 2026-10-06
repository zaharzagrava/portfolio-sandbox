# Coding Interview Process (How Not to Lose Points on a Problem You Can Solve)

> **Covers:** the non-adjacent index rule, a correct dynamic programming approach, and testing against all samples and edge cases.

Most points lost in a coding interview come from **process**, not knowledge. This doc fixes the process.

---

## 1. The 7-step routine (do it every time, even when the problem looks easy)

### Step 1: Restate the problem in your own words (1 min)
> "So I get an array of non-negative integers and need the max sum of elements where no two chosen elements are at adjacent indices, meaning if I take index i, I can't take i−1 or i+1. Right?"

### Step 2: Clarify rules and constraints (2–3 min). **Ask, don't assume.**
Generic checklist:
- **Input size** (n ≤ 10? 10^3? 10^5? 10^6?). That decides the complexity you're aiming for (table below).
- **Value ranges**: negatives? zero? duplicates? overflow beyond 2^53 (BigInt)?
- **Empty input** allowed? What should it return then?
- **Exact definitions** of the rules. For the non-adjacent problem:
  - "Adjacent" means index distance 1 only, or could it be k?
  - Is selecting **zero elements** allowed (answer 0 when all values are negative)? Or must I pick at least one?
  - Is the array **circular** (first and last adjacent)?
  - Return the **sum** or the **indices**? If indices, which ones when there's a tie?
- Is the input sorted? Can I mutate it? Is it a stream?
- Output format and edge-case expectations.

### Step 3: Work through the given examples by hand (2 min)
Compute the expected output of **each provided sample** yourself before coding. That's where you discover a misunderstood rule (e.g. "oh, sample 2 shows picking zero elements is allowed").

### Step 4: Brute force first, then optimize (3–5 min)
State the brute force and its complexity ("try all subsets: O(2^n)"). Then look for structure: **overlapping subproblems → DP**, sorted → two pointers / binary search, "top k" → heap, "next greater" → monotonic stack.

Say the plan and the complexity **before** coding, and get a nod from the interviewer.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`mergeNewestFirst`](../../packages/backend/libs/domains/community/domain/merge.ts#L19): mergeNewestFirst merges multiple pre-sorted timeline lists up to a limit, applying the 'sorted → merge' optimization over brute force. _(merge.ts)_
> - [`TopK`](../../packages/backend/libs/domains/discovery/domain/count-min-sketch.ts#L41): TopK uses a min-heap to track the K largest frequency estimates, the 'top k → heap' pattern. _(count-min-sketch.ts)_
<!-- theory-links:end -->

### Step 5: Code cleanly (10–15 min)
- Meaningful names, small helpers, no premature micro-optimization.
- Narrate key decisions.

### Step 6: Test, out loud, line by line (5 min). **This was the missing step.**
1. **Run every provided sample** by tracing your code (or actually running it if there's an environment). Write the variables' values at each iteration.
2. **Edge cases**:
   - empty input, single element, two elements
   - all equal, all negative, zeros
   - already sorted / reverse sorted
   - max size (complexity check), max values (overflow)
   - duplicates, ties
3. If you find a bug, fix it calmly and **re-run all samples**. Fixes often break other cases.

### Step 7: Complexity and follow-ups
State time and space. Mention trade-offs and how you'd extend it (streaming input, circular variant, returning indices).

---

## 2. Constraint → target complexity

| n | Feasible complexity | Typical approach |
|---|---|---|
| ≤ 10–12 | O(n!) / O(2^n · n) | permutations, brute force |
| ≤ 20–25 | O(2^n) | subsets, bitmask DP |
| ≤ 100–500 | O(n^3) | interval DP, Floyd–Warshall |
| ≤ 10^3–5·10^3 | O(n^2) | 2D DP, pairs |
| ≤ 10^5–10^6 | O(n log n) / O(n) | sort, heap, binary search, two pointers, linear DP, hash map |
| > 10^7 | O(n) / O(log n) / O(1) | math, streaming |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TopK`](../../packages/backend/libs/domains/discovery/domain/count-min-sketch.ts#L41): TopK is a min-heap heavy-hitters tracker, an example of the 'top k → heap' approach the table lists for large n. _(count-min-sketch.ts)_
<!-- theory-links:end -->

---

## 3. TypeScript / JavaScript pitfalls in coding interviews

```ts
[10, 9, 1].sort();                       // [1, 10, 9] ❌ lexicographic! use (a, b) => a - b
Array(3).fill([]);                       // same array reference ×3 ❌ use Array.from({length: 3}, () => [])
Math.max(...hugeArray);                  // RangeError: max call stack for ~100k+ elements; use a loop/reduce
-7 % 3;                                  // -1 (not 2): normalize ((x % m) + m) % m
0.1 + 0.2 === 0.3;                       // false
Number.MAX_SAFE_INTEGER;                 // 2^53-1; use BigInt for big products/mod arithmetic carefully
'abc'[1] = 'x';                          // strings immutable; use arrays of chars
new Array(n).fill(0).map(() => new Array(m).fill(0));  // 2D grid correctly
const m = new Map<number, number>(); m.get(k) ?? 0;    // default values
for (const [k, v] of map) {}             // iterate Map entries
Math.floor(a / b);                       // integer division (for negatives: Math.trunc vs floor differ)
arr.at(-1);                              // last element
```
- JS has no built-in heap or deque. Know how to write a binary heap quickly (see the patterns doc), or say "I'll assume a priority queue helper" if allowed.
- `shift()` is O(n). For BFS queues, use an index pointer (`let head = 0; while (head < q.length) q[head++]`).

---

## 4. Communication tips
- Think out loud, but in a structured way: "Two options: A is O(n²), B is O(n) using a hash map. I'll go with B."
- If you're stuck: return to the brute force, try small examples, look for a pattern, and ask for a hint gracefully. Using a hint well still scores well.
- Don't go silent for more than 30–60 s.
- Leave 5 minutes at the end for testing. Interviewers notice when you skip it.

---

## 5. Practice plan (4 weeks)

| Week | Focus | Problems/day |
|---|---|---|
| 1 | arrays, hashing, two pointers, sliding window, prefix sums, stack | 2–3 |
| 2 | binary search, heap, intervals, linked lists, trees (DFS/BFS) | 2–3 |
| 3 | **DP** (1D → 2D → knapsack → strings), backtracking | 2 |
| 4 | graphs (BFS, topo sort, union-find, Dijkstra), mixed timed mocks | 2 + 2 mocks |

Use NeetCode 150 / Blind 75 as the list. For each problem, **write tests first from the samples**, then code, then add edge-case tests. Build that habit so it carries into interviews. (Your `Algorithms/practice.ts` is a good place for this; see the DP doc for a test harness.)
