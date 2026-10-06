# Dynamic Programming: From the Non-Adjacent Problem to General Patterns

> **Covers:** the non-adjacent index rule, the dynamic programming approach, and testing against all samples and edge cases.

All code in this doc was run and fuzz-tested against brute force (Node 24, native TS).

---

## 1. The problem: max sum of non-adjacent elements ("House Robber")

> Given `nums`, choose elements so that **no two chosen indices are adjacent** (|i − j| ≥ 2). Maximize the sum.

### Clarifying questions to ask FIRST
1. Adjacent means **index distance exactly 1**? (Or is it a general gap k? See the variant below.)
2. Can values be **negative**? If so, may I choose **nothing** (answer 0), or must I pick **at least one**?
3. Is the array **circular** (first and last are neighbors)?
4. Return the sum or the **indices**?
5. Size limits? (n up to 10^5 → O(n) needed; O(2^n) brute force only as a reference.)

### Why greedy fails (show this, it impresses interviewers)
- "Take all even indices or all odd indices, whichever is bigger": `[2, 1, 1, 2]` gives evens 3, odds 3, but the answer is **4** (indices 0 and 3).
- "Always take the largest available element": `[3, 4, 3]` takes 4 → 4, but 3 + 3 = **6**.

### Deriving the DP (say these 5 things out loud)
1. **State**: `best[i]` = max sum using only elements `0..i`.
2. **Choice at i**: skip `nums[i]` → `best[i-1]`; or take it → `nums[i] + best[i-2]` (i−1 is then forbidden).
3. **Transition**: `best[i] = max(best[i-1], best[i-2] + nums[i])`.
4. **Base**: `best[-1] = best[-2] = 0` (choosing nothing).
5. **Answer**: `best[n-1]`. Only the last two values are ever used, so space is **O(1)**.

```ts
function rob(nums: number[]): number {
  let prev2 = 0;   // best up to i-2
  let prev1 = 0;   // best up to i-1
  for (const x of nums) {
    const cur = Math.max(prev1, prev2 + x);
    prev2 = prev1;
    prev1 = cur;
  }
  return prev1;
}
// Time O(n), Space O(1)
```

### Trace it on the samples (do this in the interview)
`nums = [2, 7, 9, 3, 1]`

| i | x | prev2 | prev1 | cur = max(prev1, prev2 + x) |
|---|---|---|---|---|
| 0 | 2 | 0 | 0 | max(0, 0+2) = **2** |
| 1 | 7 | 0 | 2 | max(2, 0+7) = **7** |
| 2 | 9 | 2 | 7 | max(7, 2+9) = **11** |
| 3 | 3 | 7 | 11 | max(11, 7+3) = **11** |
| 4 | 1 | 11 | 11 | max(11, 11+1) = **12** ✅ (2 + 9 + 1) |

### Tests (write them before or alongside the code)
```ts
const cases: [number[], number][] = [
  [[1, 2, 3, 1], 4],        // 1 + 3
  [[2, 7, 9, 3, 1], 12],    // 2 + 9 + 1
  [[2, 1, 1, 2], 4],        // greedy-even/odd trap
  [[], 0],                  // empty
  [[5], 5],                 // single
  [[5, 1], 5],              // two elements
  [[-1, -2], 0],            // negatives, empty selection allowed
];
for (const [input, expected] of cases) {
  const got = rob(input);
  console.assert(got === expected, `rob(${JSON.stringify(input)}) = ${got}, expected ${expected}`);
}
```

### Variant A: must choose at least one element (negatives allowed)
```ts
function robNonEmpty(nums: number[]): number {
  // best up to i with ≥1 element chosen; taking x may start fresh (ignore negative history)
  let bestPrev2 = -Infinity, bestPrev1 = -Infinity;
  for (const x of nums) {
    const take = x + Math.max(0, bestPrev2);
    const cur = Math.max(bestPrev1, take);
    bestPrev2 = bestPrev1;
    bestPrev1 = cur;
  }
  return bestPrev1;          // [-3, -1, -2] → -1
}
```

### Variant B: return the chosen indices (reconstruction)
Keep the full DP array, then walk backwards: if `dp[i] === dp[i-1]`, element i wasn't taken; otherwise it was, so jump to i−2.
```ts
function robWithIndices(nums: number[]): { sum: number; indices: number[] } {
  const n = nums.length;
  const dp = new Array<number>(n + 1).fill(0);           // dp[i] = best using first i elements
  for (let i = 1; i <= n; i++) dp[i] = Math.max(dp[i - 1], (i >= 2 ? dp[i - 2] : 0) + nums[i - 1]);
  const indices: number[] = [];
  for (let i = n; i >= 1; ) {
    if (dp[i] === dp[i - 1]) i--;
    else { indices.push(i - 1); i -= 2; }
  }
  return { sum: dp[n], indices: indices.reverse() };     // [2,7,9,3,1] → {12, [0,2,4]}
}
```

### Variant C: circular array (House Robber II)
The first and last can't both be taken, so solve two linear problems: without the last element, and without the first.
```ts
function robCircular(nums: number[]): number {
  if (nums.length === 1) return Math.max(0, nums[0]);
  return Math.max(rob(nums.slice(0, -1)), rob(nums.slice(1)));   // [2,3,2] → 3
}
```

### Variant D: chosen indices must be more than k apart
```ts
function robK(nums: number[], k: number): number {
  const best = new Array<number>(nums.length).fill(0);
  for (let i = 0; i < nums.length; i++) {
    const take = nums[i] + (i - k - 1 >= 0 ? best[i - k - 1] : 0);
    best[i] = Math.max(i > 0 ? best[i - 1] : 0, take);
  }
  return nums.length ? best[nums.length - 1] : 0;
}
```

### Variant E: on a tree (House Robber III; you can't take parent and child together)
Return a pair `[withNode, withoutNode]` from each subtree (post-order DFS):
```ts
type TreeNode = { val: number; left?: TreeNode; right?: TreeNode };
function robTree(root?: TreeNode): number {
  const go = (n?: TreeNode): [number, number] => {
    if (!n) return [0, 0];
    const [lTake, lSkip] = go(n.left);
    const [rTake, rSkip] = go(n.right);
    return [n.val + lSkip + rSkip, Math.max(lTake, lSkip) + Math.max(rTake, rSkip)];
  };
  return Math.max(...go(root));
}
```

### Variant F: "Delete and Earn" reduces to the same problem
Taking value v deletes v−1 and v+1. Bucket the points per value (`points[v] = v × count(v)`), then run `rob(points)`, because adjacent *values* behave like adjacent indices.

---

## 2. DP methodology (applies to every DP problem)

1. **Recognize it**: "max/min/count the number of ways", "can you reach", choices at each step, **overlapping subproblems**, and **optimal substructure**.
2. **Define the state** precisely in words: "dp[i][j] = min edits to turn a[0..i) into b[0..j)".
3. **Transition**: enumerate the choices at that state.
4. **Base cases**: the empty prefix, zero capacity, and so on.
5. **Order of computation**: make dependencies come first (or use memoized recursion).
6. **Answer location**: dp[n], max over dp, dp[n][m]...
7. **Optimize space**: if a row depends only on the previous row, keep two rows (or one, iterating in the right direction).

**Top-down (memoization) vs bottom-up (tabulation):**
- Top-down: write the recursion, add a cache. Easiest to derive, but has a recursion depth limit (~10k frames in JS, so it can stack overflow for n = 10^5).
- Bottom-up: iterative, no stack issues, space optimization is easier.
- Interview strategy: derive top-down verbally, implement bottom-up if n is large.

---

## 3. Pattern catalog (all verified)

### 3.1 1D linear DP
```ts
// Coin change: min coins to make amount (unbounded items)
function coinChange(coins: number[], amount: number): number {
  const dp = new Array<number>(amount + 1).fill(Infinity); dp[0] = 0;
  for (let a = 1; a <= amount; a++)
    for (const c of coins) if (c <= a && dp[a - c] + 1 < dp[a]) dp[a] = dp[a - c] + 1;
  return dp[amount] === Infinity ? -1 : dp[amount];      // ([1,2,5], 11) → 3
}

// Word break
function wordBreak(s: string, dict: string[]): boolean {
  const words = new Set(dict); const dp = new Array<boolean>(s.length + 1).fill(false); dp[0] = true;
  for (let i = 1; i <= s.length; i++)
    for (let j = 0; j < i; j++) if (dp[j] && words.has(s.slice(j, i))) { dp[i] = true; break; }
  return dp[s.length];
}
```
Others: climbing stairs, decode ways, house robber, max subarray (Kadane: `cur = max(x, cur + x)`).

### 3.2 LIS in O(n log n) (patience sorting)
```ts
function lengthOfLIS(nums: number[]): number {
  const tails: number[] = [];                   // tails[k] = smallest tail of an increasing subsequence of length k+1
  for (const x of nums) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < x) lo = mid + 1; else hi = mid; }
    tails[lo] = x;
  }
  return tails.length;                           // [10,9,2,5,3,7,101,18] → 4
}
```

### 3.3 Grid DP
```ts
function uniquePaths(m: number, n: number): number {   // 1D rolling row
  const row = new Array<number>(n).fill(1);
  for (let i = 1; i < m; i++) for (let j = 1; j < n; j++) row[j] += row[j - 1];
  return row[n - 1];                                    // (3,7) → 28
}
```
Variants: obstacles (set the cell to 0), min path sum, dungeon game (compute backwards).

### 3.4 Two-sequence DP (strings)
```ts
function lcs(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];                         // ('abcde','ace') → 3
}

function editDistance(a: string, b: string): number {    // Levenshtein, O(m) space
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]); // replace, delete, insert
    prev = cur;
  }
  return prev[b.length];                                 // ('horse','ros') → 3
}
```

### 3.5 Knapsack
```ts
// 0/1 knapsack: each item at most once → iterate capacity DOWNWARD
function knapsack01(weights: number[], values: number[], cap: number): number {
  const dp = new Array<number>(cap + 1).fill(0);
  for (let i = 0; i < weights.length; i++)
    for (let w = cap; w >= weights[i]; w--) dp[w] = Math.max(dp[w], dp[w - weights[i]] + values[i]);
  return dp[cap];
}
// Unbounded (items reusable) → iterate capacity UPWARD (like coin change)
```
Recognize the disguises: "partition equal subset sum" (0/1 subset sum), "target sum" (count subsets), "coin change II" (count combinations: loop coins on the outside, amounts on the inside).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`allocate`](../../packages/backend/libs/common/money/allocate.ts#L10): `allocate` splits a total across weights with the largest-remainder method so parts sum exactly to the total, a combinatorial allocation problem rather than knapsack DP. _(allocate.ts)_ · [money](../../docs/humans/concepts/common-money/money.md)
<!-- theory-links:end -->

### 3.6 State-machine DP (stock problems)
```ts
// Best time to buy/sell with cooldown
function maxProfitCooldown(prices: number[]): number {
  let hold = -Infinity, sold = 0, rest = 0;
  for (const p of prices) {
    const prevSold = sold;
    sold = hold + p;                  // sell today
    hold = Math.max(hold, rest - p);  // keep holding or buy (only from rest = after cooldown)
    rest = Math.max(rest, prevSold);  // cooldown/idle
  }
  return Math.max(sold, rest);         // [1,2,3,0,2] → 3
}
```

### 3.7 Others to recognize
- **Interval DP**: `dp[i][j]` over subarrays (burst balloons, matrix chain, palindrome partitioning). O(n³).
- **Bitmask DP**: n ≤ 20, `dp[mask]` over subsets (TSP, assignment).
- **Tree DP**: return tuples from children (House Robber III, diameter, max path sum).
- **Digit DP**: counting numbers with properties up to N.

---

## 4. A test harness for practice (use it in `Algorithms/practice.ts`)

```ts
function check<A extends unknown[], R>(fn: (...args: A) => R, cases: [A, R][]) {
  for (const [args, expected] of cases) {
    const got = fn(...args);
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    console.log(`${ok ? '✅' : '❌'} ${fn.name}(${args.map(a => JSON.stringify(a)).join(', ')}) = ${JSON.stringify(got)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
  }
}
check(rob, [[[[1, 2, 3, 1]], 4], [[[2, 1, 1, 2]], 4], [[[]], 0]]);
// run: node Algorithms/practice.ts   (Node 23.6+/22.18+ strips types natively)
```

**Fuzz against brute force** when you're unsure (it's how this doc was verified):
```ts
function brute(nums: number[]): number {
  let best = 0;
  for (let mask = 0; mask < 1 << nums.length; mask++) {
    if (mask & (mask >> 1)) continue;                  // adjacent bits set → invalid
    let s = 0; for (let i = 0; i < nums.length; i++) if (mask & (1 << i)) s += nums[i];
    best = Math.max(best, s);
  }
  return best;
}
for (let t = 0; t < 2000; t++) {
  const a = Array.from({ length: Math.floor(Math.random() * 12) }, () => Math.floor(Math.random() * 21) - 8);
  if (rob(a) !== brute(a)) { console.log('mismatch', a); break; }
}
```
