# Pattern Map: how to find the solution to an algorithm problem

The [cheat sheet](03-patterns-cheatsheet.md) has a template for each pattern. This page is the step before that: **how to tell which pattern a new problem needs**. Templates: [cheat sheet](03-patterns-cheatsheet.md). DP in depth: [DP doc](02-dynamic-programming.md). Interview flow: [process](01-coding-interview-process.md).

---

## 1. The one method: brute force → repeated work → what to remember

Almost every pattern answers the same question: **"What does the slow solution compute again and again, and what can I store so I don't have to?"**

1. **Restate** the problem and do one example by hand.
2. **Write the brute force** (usually nested loops, or "try everything") and say its cost out loud.
3. **Find the repeated work**: what does the inner loop (or the recursion) recompute each time?
4. **Pick what to remember** so that work disappears. That choice *is* the pattern (section 2).
5. **Name the invariant**: one sentence that is true at every step (section 7). If you can't say it, the code will have off-by-one bugs.
6. **Code it, then trace your example** line by line, and check the edge cases (section 9).

Three lines to write before coding, every time:
```
Brute force: for each day, scan all earlier days for the min price → O(n²)
Repeated:    "min price before day i" is recomputed from scratch for every i
Remember:    minSoFar, updated as I go → O(n), O(1)
```
If you can write those three lines, you can solve the problem. If you can't, the problem is in step 3: look at the inner loop and ask what it is *looking for*.

---

## 2. Master table: repeated work → what to remember → pattern

| The slow solution keeps…                                      | Remember this instead                                                                                | Pattern                     | Cost: before → after                | Drills                                                                                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scanning the array to find "is there an x?" / "where is x?"   | a **Set / Map** of what you've seen                                                                  | Hashing                     | O(n²) → O(n)                        | [001](../practice/live-coding/03-algorithms.md#algo-001), [002](../practice/live-coding/03-algorithms.md#algo-002), [007](../practice/live-coding/03-algorithms.md#algo-007) |
| recounting how many times something occurs                    | a **count map** (or a 26-slot array)                                                                 | Counting                    | O(n·k) → O(n)                       | [003](../practice/live-coding/03-algorithms.md#algo-003), [004](../practice/live-coding/03-algorithms.md#algo-004), [005](../practice/live-coding/03-algorithms.md#algo-005) |
| recomputing the best/min/max of everything before i           | **one running variable** (`minSoFar`, best ending here)                                              | Running best / Kadane       | O(n²) → O(n)                        | [016](../practice/live-coding/03-algorithms.md#algo-016), [091](../practice/live-coding/03-algorithms.md#algo-091)                                                           |
| re-summing a range i..j                                       | **prefix sums** `pre[j+1] − pre[i]`, or a map of prefix sums seen                                    | Prefix sums                 | O(n) per query → O(1)               | [006](../practice/live-coding/03-algorithms.md#algo-006), [043](../practice/live-coding/03-algorithms.md#algo-043)                                                           |
| rebuilding a window from scratch at every start               | the window's **state** (counts, sum) + two edges: add the new right element, remove the old left one | Sliding window              | O(n²) or O(n·k) → O(n)              | [017](../practice/live-coding/03-algorithms.md#algo-017)–[021](../practice/live-coding/03-algorithms.md#algo-021)                                                            |
| testing every pair in **sorted** data                         | **two indexes**; each step discards one candidate forever                                            | Two pointers                | O(n²) → O(n)                        | [011](../practice/live-coding/03-algorithms.md#algo-011)–[015](../practice/live-coding/03-algorithms.md#algo-015)                                                            |
| scanning ahead from every i for the next bigger/smaller value | a **stack of items still waiting** for their answer                                                  | Monotonic stack             | O(n²) → O(n)                        | [025](../practice/live-coding/03-algorithms.md#algo-025), [026](../practice/live-coding/03-algorithms.md#algo-026)                                                           |
| recomputing the max of every window                           | a **deque of candidates** that could still be a max                                                  | Monotonic deque             | O(n·k) → O(n)                       | [021](../practice/live-coding/03-algorithms.md#algo-021)                                                                                                                     |
| checking every position in sorted / monotonic data            | **lo and hi** bounds that always contain the answer; halve each step                                 | Binary search               | O(n) → O(log n)                     | [027](../practice/live-coding/03-algorithms.md#algo-027)–[032](../practice/live-coding/03-algorithms.md#algo-032)                                                            |
| trying every candidate answer x ("smallest speed that works") | the same lo/hi over the **answer range**, since `works(x)` flips from false to true once             | Binary search on the answer | O(range·n) → O(n·log range)         | [029](../practice/live-coding/03-algorithms.md#algo-029)                                                                                                                     |
| re-sorting or re-scanning to find the current min/max         | a **heap**                                                                                           | Heap                        | O(n) per step → O(log n)            | [061](../practice/live-coding/03-algorithms.md#algo-061)–[065](../practice/live-coding/03-algorithms.md#algo-065)                                                            |
| comparing every interval with every other                     | **sort by start (or end)**, then one sweep keeping the "current" interval                            | Intervals                   | O(n²) → O(n log n)                  | [039](../practice/live-coding/03-algorithms.md#algo-039)–[042](../practice/live-coding/03-algorithms.md#algo-042)                                                            |
| solving the same subproblem many times in recursion           | a **memo / table** of sub-answers                                                                    | Dynamic programming         | exponential → O(states × choices)   | [081](../practice/live-coding/03-algorithms.md#algo-081)–[092](../practice/live-coding/03-algorithms.md#algo-092)                                                            |
| exploring a grid/graph and re-visiting cells                  | a **visited** set; BFS keeps the frontier level by level                                             | BFS / DFS                   | exponential/repeated → O(V + E)     | [066](../practice/live-coding/03-algorithms.md#algo-066), [071](../practice/live-coding/03-algorithms.md#algo-071), [074](../practice/live-coding/03-algorithms.md#algo-074) |
| re-walking a graph to answer "are a and b connected?"         | **union-find**: each node points toward its group's root                                             | Union-find                  | O(V+E) per query → ~O(1)            | [073](../practice/live-coding/03-algorithms.md#algo-073)                                                                                                                     |
| retrying tasks until all dependencies are done                | **in-degree counts** + a queue of tasks with none left                                               | Topological sort            | repeated passes → O(V + E)          | [069](../practice/live-coding/03-algorithms.md#algo-069), [070](../practice/live-coding/03-algorithms.md#algo-070), [099](../practice/live-coding/03-algorithms.md#algo-099) |
| re-scanning words that share a prefix                         | a **trie**: each prefix stored once                                                                  | Trie                        | O(words × len) per lookup → O(len)  | [096](../practice/live-coding/03-algorithms.md#algo-096), [097](../practice/live-coding/03-algorithms.md#algo-097)                                                           |
| needing all combinations (no way around listing them)         | the **current partial choice**; undo after each branch; prune early                                  | Backtracking                | unavoidable exponential, but pruned | [075](../practice/live-coding/03-algorithms.md#algo-075)–[079](../practice/live-coding/03-algorithms.md#algo-079)                                                            |
| copying a linked list into an array to index it               | **two pointers at different speeds** / a dummy head                                                  | Fast & slow pointers        | O(n) space → O(1)                   | [033](../practice/live-coding/03-algorithms.md#algo-033)–[037](../practice/live-coding/03-algorithms.md#algo-037), [024](../practice/live-coding/03-algorithms.md#algo-024)  |
| storing every value to find the odd one out                   | **XOR** of everything (pairs cancel)                                                                 | Bits                        | O(n) space → O(1)                   | [098](../practice/live-coding/03-algorithms.md#algo-098)                                                                                                                     |

---

## 3. Read the constraints: input size tells you the target complexity

Interviewers (and LeetCode) choose `n` so that the intended solution fits; the wrong complexity is usually too slow by orders of magnitude. JS does roughly 10⁷–10⁸ simple operations per second.

| n up to | Target | What that usually means |
|---|---|---|
| ~10–12 | O(n!) | all permutations, backtracking |
| ~20–25 | O(2ⁿ) | all subsets, bitmask DP |
| ~100–500 | O(n³) | triple loop, interval DP, Floyd–Warshall |
| ~1,000–5,000 | O(n²) | double loop, 2-D DP (LCS, edit distance) |
| ~10⁵–10⁶ | O(n log n) or O(n) | sort + sweep, heap, binary search, hash map, two pointers, sliding window |
| values up to 10⁹, n huge | O(log n) or O(log range) | binary search, math |

No constraints given? **Ask**: "how big can the input get?" It is a normal clarifying question and it tells you which pattern they expect.

---

## 4. Signals by input shape

| Input | Try first | Then |
|---|---|---|
| unsorted array, pairs / target / duplicates | hash map / set | sort + two pointers (if order doesn't matter and O(1) space is asked) |
| **sorted** array (or "sort it first" is allowed) | two pointers, binary search | |
| contiguous **subarray / substring** with a condition | sliding window (all values positive, or "at most k" / "no repeats") | prefix sum + hash map (negatives, "sum exactly k") |
| **subsequence** (not contiguous) | DP | greedy (if provably safe), backtracking (to list them all) |
| brackets, nested structure, "undo", expression evaluation | stack | |
| "next greater / smaller", spans, histograms | monotonic stack | |
| linked list | dummy head, fast/slow, reverse in place | |
| binary tree | DFS that returns a value from each subtree | BFS for anything "per level" |
| binary **search** tree | in-order = sorted; pass (min, max) bounds down | |
| grid of cells | BFS (shortest steps) / DFS (flood fill), 4 directions + visited | DP if moves only go right/down |
| graph as edges | adjacency list → BFS (unweighted shortest), Dijkstra (weighted ≥ 0), topo sort (dependencies), union-find (connectivity) | |
| list of intervals | sort by start → merge/insert; sort by end → max non-overlapping | heap of end times for "how many rooms" |
| stream, "top k", "k-th", running median | heap (size k) | quickselect for one-off k-th |
| list of words, prefixes | trie | hash set if only whole words |
| 2-D matrix transforms | index maps (transpose + reverse), boundaries that shrink | |
| "design a structure with O(1) ops" | combine two structures (Map + list, Map + array) | |

---

## 5. Signals in the wording

| The problem says… | Think |
|---|---|
| "in O(1) extra space", "in place" | two pointers, swap, reuse the input array, index as a marker |
| "O(log n)" | binary search, no matter what the data looks like |
| "sorted and rotated" | binary search; one half is always sorted, check which |
| "at most k distinct / at most k changes" | sliding window |
| "exactly k" | prefix sum + hash map, or `atMost(k) − atMost(k−1)` |
| "minimum number of steps / moves" | BFS |
| "shortest path" with weights | Dijkstra |
| "number of ways" | DP (counting) |
| "minimum cost / maximum value" with choices | DP; greedy only if you can prove it |
| "can you reach / is it possible" | greedy (track the farthest reach) or BFS/DP |
| "return **all** combinations / subsets / permutations / paths" | backtracking |
| "minimize the maximum" / "maximize the minimum" / "smallest X such that" | binary search on the answer |
| "k-th largest / top k / k closest" | heap of size k |
| "next greater / warmer / higher" | monotonic stack |
| "overlapping", "meetings", "merge ranges" | sort intervals + sweep |
| "order of tasks / prerequisites / dependencies" | topological sort |
| "connected / groups / provinces / islands" | DFS/BFS or union-find |
| "cycle" | fast/slow pointers (list), DFS colors or topo sort (directed), union-find (undirected) |
| "appears once, others twice" | XOR |
| "longest increasing" | DP O(n²), or patience sorting O(n log n) |
| "palindrome" | two pointers from the ends, or expand from the center |

---

## 6. DP vs greedy vs backtracking: which one?

All three handle "make a sequence of choices". Ask in this order:
1. **Do they want every solution listed?** → **Backtracking.** Output is exponential anyway; your job is to prune.
2. **Do they want the best / a count, and do choices interact?** (a choice now changes what's possible later, and the same "situation" comes back via different paths) → **DP.** Define the state ("what do I need to know to continue?"), the transition (the choices), the base case.
3. **Is there a local choice that can never hurt?** (you can argue: "swapping any optimal solution's choice for mine is never worse") → **Greedy.** Examples: jump game (track farthest reach), non-overlapping intervals (keep the one that ends first).

If you're unsure whether greedy is safe, say so and use DP. A correct O(n²) DP beats a wrong O(n) greedy.

---

## 7. The invariant: one sentence that is true at every step

Say it out loud before coding. Most bugs are a broken invariant.

| Pattern | Invariant |
|---|---|
| Hash map (two sum) | the map holds every element **before** the current index |
| Sliding window | `[left, right]` is always a valid window; I only move `left` to restore validity |
| Two pointers (sorted pair) | the answer, if any, lies between `left` and `right` |
| Binary search | the answer is always inside `[lo, hi]`; every step shrinks the range |
| Monotonic stack | the stack holds indices still waiting for their answer, values strictly decreasing (or increasing) |
| Prefix sums | `pre[i]` = sum of the first `i` elements; `pre[0] = 0` |
| Heap of size k | the heap holds the k largest elements seen so far; its root is the k-th largest |
| BFS | everything in the queue is at distance d or d+1; mark visited **when pushing**, not when popping |
| DFS on a tree | each call returns the answer **for its subtree**; the parent combines them |
| Backtracking | `path` holds the current partial choice; whatever I push, I pop after the recursive call |
| DP | `dp[i]` = the answer for the first `i` items (or the subproblem I defined), already final when I read it |
| Union-find | every node's parent chain ends at its group's root |
| Topological sort | the queue holds exactly the nodes whose prerequisites are all done |
| Fast & slow | fast moves 2, slow moves 1; if they meet, there is a cycle |

---
## 8. All 100 drills: brute force → what you remember → pattern

### Hashing & counting

| Drill                                                                                      | Brute force (cost) and what it recomputes                                | What you remember instead                                                              | Result                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------- |
| [algo-001 Two Sum](../practice/live-coding/03-algorithms.md#algo-001)                      | Check every pair, O(n²): for each x re-scans the array for target − x    | A map value → index of everything seen so far; look up target − x before inserting x   | O(n) / O(n)                |
| [algo-002 Contains Duplicate](../practice/live-coding/03-algorithms.md#algo-002)           | Compare all pairs, O(n²); or sort, O(n log n)                            | A Set of values seen; stop at the first value already in it                            | O(n) / O(n)                |
| [algo-003 Valid Anagram](../practice/live-coding/03-algorithms.md#algo-003)                | Sort both strings and compare, O(n log n)                                | Letter counts: +1 for s, −1 for t; check lengths first                                 | O(n) / O(1) for 26 letters |
| [algo-004 Group Anagrams](../practice/live-coding/03-algorithms.md#algo-004)               | Compare every pair of strings, O(n² · k)                                 | Map canonical key → group; 26-count key with separators (sorted letters costs k log k) | O(n · k) / O(n · k)        |
| [algo-005 Top K Frequent Elements](../practice/live-coding/03-algorithms.md#algo-005)      | Count, then sort entries by count, O(n log n); size-k heap is O(n log k) | Buckets indexed by frequency (max n); read from highest bucket down                    | O(n) / O(n)                |
| [algo-007 Longest Consecutive Sequence](../practice/live-coding/03-algorithms.md#algo-007) | Sort and scan, O(n log n)                                                | A Set; only start counting at x where x − 1 is absent, so each run is walked once      | O(n) / O(n)                |
| [algo-008 Majority Element](../practice/live-coding/03-algorithms.md#algo-008)             | Count map, O(n) space; or sort and take middle, O(n log n)               | One candidate and a vote counter; others cancel votes, majority survives               | O(n) / O(1)                |

### Two pointers

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-010 Valid Palindrome](../practice/live-coding/03-algorithms.md#algo-010) | Build cleaned lowercase copy and compare with its reverse: O(n) extra space | Two indexes from both ends, skipping non-alphanumerics, comparing in place | O(n) / O(1) |
| [algo-011 Two Sum II (Sorted Input)](../practice/live-coding/03-algorithms.md#algo-011) | Hash map, O(n) space, ignores sorting; or binary search per element, O(n log n) | Left/right ends: sum too small → move left, too big → move right; each step drops one element | O(n) / O(1) |
| [algo-012 3Sum](../practice/live-coding/03-algorithms.md#algo-012) | All triples, O(n³), plus a set to dedupe | Sort; fix first element, run Two Sum II on the rest; skip equal neighbours | O(n²) / O(n) sorted copy |
| [algo-013 Container With Most Water](../practice/live-coding/03-algorithms.md#algo-013) | Check every pair, O(n²) | Start widest; shorter line caps area, so only moving the shorter one can help | O(n) / O(1) |
| [algo-014 Trapping Rain Water](../practice/live-coding/03-algorithms.md#algo-014) | Per bar, rescan for max left and max right, O(n²) | Running max on each side; process the lower side, its max sets the water level | O(n) / O(1) |
| [algo-015 Move Zeroes](../practice/live-coding/03-algorithms.md#algo-015) | Copy non-zeros to a new array and pad zeros: O(n) space, not in place | A write index; swap each non-zero to it | O(n) / O(1) |
| [algo-024 Find the Duplicate Number](../practice/live-coding/03-algorithms.md#algo-024) | Compare every pair, O(n²); Set is O(n) space; sorting mutates | Two positions (slow/fast) on the i → nums[i] list; cycle entrance is the duplicate | O(n) / O(1) |
| [algo-044 Merge Sorted Array](../practice/live-coding/03-algorithms.md#algo-044) | Copy and sort, O((m+n) log(m+n)); or merge from front with shifting, O(m · n) | Fill from the back: write the larger of the two tails into the last free slot | O(m + n) / O(1) |
| [algo-047 Valid Palindrome II](../practice/live-coding/03-algorithms.md#algo-047) | Delete each char in turn and recheck, O(n²) | Prefix matched so far is fine; at first mismatch try skipping left or right only | O(n) / O(1) |
| [algo-050 Longest Palindromic Substring](../practice/live-coding/03-algorithms.md#algo-050) | Check all substrings, O(n³): re-verifies the same inner part | Expand from each of 2n − 1 centers; each step reuses the confirmed inner match | O(n²) / O(1) |

### Sliding window

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-016 Best Time to Buy and Sell Stock](../practice/live-coding/03-algorithms.md#algo-016) | Every buy/sell pair, O(n²): rescans earlier days for the cheapest buy | Cheapest price so far and best profit so far | O(n) / O(1) |
| [algo-017 Longest Substring Without Repeating Characters](../practice/live-coding/03-algorithms.md#algo-017) | Check every substring for uniqueness, O(n³) or O(n²) with a set | Last index of each char; jump left past a repeat if it is inside the window | O(n) / O(k) |
| [algo-018 Longest Repeating Character Replacement](../practice/live-coding/03-algorithms.md#algo-018) | Check every substring, O(n²) or worse | 26 window counts and maxFreq; valid while length − maxFreq ≤ k | O(n) / O(1) |
| [algo-019 Permutation in String](../practice/live-coding/03-algorithms.md#algo-019) | All permutations of s1 (factorial), or sort every window, O(n · m log m) | Fixed window counts plus number of letters whose counts match | O(n) / O(1) |
| [algo-020 Minimum Window Substring](../practice/live-coding/03-algorithms.md#algo-020) | Check every substring for coverage, O(n² · \|t\|) or worse | Need-counts (negative = surplus) and one `missing` counter; expand, then shrink | O(\|s\| + \|t\|) / O(k) |

### Prefix sums & passes

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-006 Product of Array Except Self](../practice/live-coding/03-algorithms.md#algo-006) | Multiply all others per index, O(n²); division fails on zeros and is banned | Prefix products in the output, then a running suffix product from the right | O(n) / O(1) extra |
| [algo-043 Subarray Sum Equals K](../practice/live-coding/03-algorithms.md#algo-043) | Sum every subarray, O(n²) | Map prefix sum → count, seeded {0: 1}; look up prefix − k | O(n) / O(n) |

### String scanning

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-045 Longest Common Prefix](../practice/live-coding/03-algorithms.md#algo-045) | Compare every string with every other, or re-check whole prefixes per length | Scan column by column; earlier columns already matched | O(S) / O(1) |
| [algo-049 Roman to Integer](../practice/live-coding/03-algorithms.md#algo-049) | Hard-code the six subtractive pairs: works but clunky | Rule: a symbol before a larger one is subtracted; one pass comparing with the next | O(n) / O(1) |
| [algo-009 Encode and Decode Strings](../practice/live-coding/03-algorithms.md#algo-009) | Join with a delimiter: breaks when a string contains it; escaping is fiddly | Length prefix + '#'; decoder reads the length, jumps that many chars | O(n) / O(n) |

### Matrix

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-046 Rotate Image](../practice/live-coding/03-algorithms.md#algo-046) | Build a second matrix with (r, c) → (c, n−1−r): O(n²) extra space, forbidden | Rotation = transpose + mirror rows; only one value held per swap | O(n²) / O(1) |
| [algo-048 Spiral Matrix](../practice/live-coding/03-algorithms.md#algo-048) | Walker with direction and visited matrix: O(m · n) extra space | Four edges of the unvisited rectangle; shrink one edge per side | O(m · n) / O(1) extra |

### Stack & monotonic stack/deque

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-021 Sliding Window Maximum](../practice/live-coding/03-algorithms.md#algo-021) | Scan each window, O(n · k); heap is O(n log n) | Deque of indices with decreasing values; front is the max | O(n) / O(k) |
| [algo-022 Valid Parentheses](../practice/live-coding/03-algorithms.md#algo-022) | Repeatedly delete "()", "[]", "{}" until stable, O(n²) | A stack of open brackets; each closer must match the top | O(n) / O(n) |
| [algo-023 Min Stack](../practice/live-coding/03-algorithms.md#algo-023) | Scan stack for min, O(n) per call; one min variable breaks on pop | Parallel stack of min-so-far, pushed and popped together | O(1) all ops / O(n) |
| [algo-025 Daily Temperatures](../practice/live-coding/03-algorithms.md#algo-025) | Look ahead from every day, O(n²) | Decreasing stack of days still waiting for a warmer day | O(n) / O(n) |
| [algo-026 Largest Rectangle in Histogram](../practice/live-coding/03-algorithms.md#algo-026) | Every pair or expand from each bar, O(n²) | Increasing stack; on pop, right limit = i, left limit = new top; sentinel 0 | O(n) / O(n) |

### Binary search

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-027 Binary Search](../practice/live-coding/03-algorithms.md#algo-027) | Linear scan, O(n) | Inclusive range [lo, hi] that must hold the target; halve via mid | O(log n) / O(1) |
| [algo-028 Search a 2D Matrix](../practice/live-coding/03-algorithms.md#algo-028) | Scan every cell, O(m · n); or binary search each row, O(m log n) | Treat as one sorted array; index i → (i / cols, i % cols) | O(log(m · n)) / O(1) |
| [algo-029 Koko Eating Bananas](../practice/live-coding/03-algorithms.md#algo-029) | Try every speed 1..max, O(n · max) | If speed k works, faster works: binary search first valid speed | O(n log m) / O(1) |
| [algo-030 Find Minimum in Rotated Sorted Array](../practice/live-coding/03-algorithms.md#algo-030) | Linear scan, O(n) | Compare mid with hi: nums[mid] > nums[hi] → min is right of mid | O(log n) / O(1) |
| [algo-031 Search in Rotated Sorted Array](../practice/live-coding/03-algorithms.md#algo-031) | Linear scan, O(n) | One half around mid is always sorted; check if target is in its range | O(log n) / O(1) |
| [algo-032 Find First and Last Position of Element](../practice/live-coding/03-algorithms.md#algo-032) | Find any match, then scan outward: O(n) when all equal | Two lower-bound searches: lowerBound(target) and lowerBound(target + 1) − 1 | O(log n) / O(1) |

### Linked lists

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-033 Reverse Linked List](../practice/live-coding/03-algorithms.md#algo-033) | Copy values to an array and rebuild: O(n) extra space | `prev` and `curr`; save `curr.next` before flipping the pointer | O(n) / O(1) |
| [algo-034 Merge Two Sorted Lists](../practice/live-coding/03-algorithms.md#algo-034) | Collect all values, sort, rebuild: O((n+m) log(n+m)) and extra space | Lists are sorted: take the smaller head onto a tail; dummy head | O(n + m) / O(1) |
| [algo-035 Linked List Cycle](../practice/live-coding/03-algorithms.md#algo-035) | Set of visited nodes: O(n) space | Slow (1 step) and fast (2 steps); they meet only if there is a cycle | O(n) / O(1) |
| [algo-036 Remove Nth Node From End of List](../practice/live-coding/03-algorithms.md#algo-036) | Two passes: count length L, then walk to L − n | Gap of n + 1 between fast and slow from a dummy; one pass | O(L) / O(1) |
| [algo-037 Reorder List](../practice/live-coding/03-algorithms.md#algo-037) | Push nodes into an array, relink from both ends: O(n) space | Find middle, reverse second half, merge alternately; cut first half | O(n) / O(1) |
| [algo-038 Add Two Numbers](../practice/live-coding/03-algorithms.md#algo-038) | Convert lists to numbers and add: overflows beyond 2^53 | Digit-by-digit addition with a carry, while either list or carry remains | O(max(n, m)) / O(max(n, m)) |

### Intervals

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-039 Merge Intervals](../practice/live-coding/03-algorithms.md#algo-039) | Compare every pair repeatedly until nothing merges, O(n²) or worse | Sort by start; only the last merged block can overlap the next interval | O(n log n) / O(n) |
| [algo-040 Insert Interval](../practice/live-coding/03-algorithms.md#algo-040) | Append and rerun Merge Intervals, O(n log n): ignores existing order | One pass: copy before, absorb overlaps into one interval, copy after | O(n) / O(n) |
| [algo-041 Non-overlapping Intervals](../practice/live-coding/03-algorithms.md#algo-041) | Try all subsets, exponential | Sort by end; keep the earliest-ending interval, track last kept end | O(n log n) / O(n) sorted copy |
| [algo-042 Meeting Rooms II](../practice/live-coding/03-algorithms.md#algo-042) | For every time point count active meetings, O(n²) | Sorted starts and sorted ends; sweep, release ended rooms before each start | O(n log n) / O(n) |

### Trees

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-051 Maximum Depth of Binary Tree](../practice/live-coding/03-algorithms.md#algo-051) | — no real brute force; key is the recursive definition | depth = 1 + max(left, right); null → 0 | O(n) / O(h) |
| [algo-052 Invert Binary Tree](../practice/live-coding/03-algorithms.md#algo-052) | — key observation: swap children at every node | Save `left` before overwriting, recurse into both | O(n) / O(h) |
| [algo-053 Same Tree](../practice/live-coding/03-algorithms.md#algo-053) | Serialize both and compare: extra memory, needs null markers | Lockstep DFS; stop at first value or shape mismatch | O(n) / O(h) |
| [algo-054 Subtree of Another Tree](../practice/live-coding/03-algorithms.md#algo-054) | Run Same Tree from every node, O(m · n): this is the expected answer | Optimal: serialize with null markers + KMP, or subtree hashes | O(m · n) / O(h); optimal O(m + n) |
| [algo-055 Binary Tree Level Order Traversal](../practice/live-coding/03-algorithms.md#algo-055) | Depth-limited DFS per level, O(n · h): re-walks the top each time | BFS frontier; snapshot queue length per level | O(n) / O(w) |
| [algo-056 Validate Binary Search Tree](../practice/live-coding/03-algorithms.md#algo-056) | Check each node against all values in its subtrees, O(n²) | An open (low, high) range passed down from ancestors | O(n) / O(h) |
| [algo-057 Lowest Common Ancestor of a BST](../practice/live-coding/03-algorithms.md#algo-057) | Generic binary-tree LCA or store both root paths: ignores ordering | BST order: both smaller → left, both larger → right, else here | O(h) / O(1) |
| [algo-058 Kth Smallest Element in a BST](../practice/live-coding/03-algorithms.md#algo-058) | Collect all values and sort, O(n log n) | In-order walk is already sorted; stop at the k-th node | O(h + k) / O(h) |
| [algo-059 Diameter of Binary Tree](../practice/live-coding/03-algorithms.md#algo-059) | Compute heights separately for every node, O(n²) on skewed trees | One post-order DFS returns height, records left + right as best | O(n) / O(h) |
| [algo-060 Path Sum](../practice/live-coding/03-algorithms.md#algo-060) | — key observation: subtract as you descend | Remaining target; check for 0 only at leaves | O(n) / O(h) |
| [algo-083 Construct Binary Tree from Preorder and Inorder Traversal](../practice/live-coding/03-algorithms.md#algo-083) | `indexOf` + slice per subtree, O(n²): re-scans and copies inorder | Map value → inorder index, index bounds, one shared preorder pointer | O(n) / O(n) |
| [algo-094 Binary Tree Maximum Path Sum](../practice/live-coding/03-algorithms.md#algo-094) | Every pair of end nodes, sum path: recomputes the same downward sums | Each node's best downward gain (clamped at 0); record val + left + right | O(n) / O(h) |
| [algo-095 Serialize and Deserialize Binary Tree](../practice/live-coding/03-algorithms.md#algo-095) | Store preorder + inorder, rebuild with `indexOf`, O(n²); breaks on duplicates | Preorder with '#' null markers; parser with one shared cursor | O(n) / O(n) |

### Heap

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-061 Kth Largest Element in an Array](../practice/live-coding/03-algorithms.md#algo-061) | Sort and index n − k, O(n log n) | Size-k min-heap of the k largest; root is the answer | O(n log k) / O(k) |
| [algo-062 K Closest Points to Origin](../practice/live-coding/03-algorithms.md#algo-062) | Sort all points by distance, O(n log n) | Size-k max-heap by squared distance; evict the farthest | O(n log k) / O(k) |
| [algo-063 Merge k Sorted Lists](../practice/live-coding/03-algorithms.md#algo-063) | Scan all k heads each step, O(N · k); or concatenate and sort | Min-heap of the k current heads; push successor after each pop | O(N log k) / O(k) |
| [algo-064 Find Median from Data Stream](../practice/live-coding/03-algorithms.md#algo-064) | Insert into sorted array, O(n) per insert from shifting | Max-heap for low half, min-heap for high half, balanced | add O(log n), median O(1) / O(n) |

### Graphs (BFS/DFS, topo sort, Dijkstra, union-find)

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-066 Number of Islands](../practice/live-coding/03-algorithms.md#algo-066) | Search from each land cell without marking: re-explores and re-counts islands | Visited marks (set on push); each unvisited land cell starts one flood fill | O(m · n) / O(m · n) |
| [algo-067 Pacific Atlantic Water Flow](../practice/live-coding/03-algorithms.md#algo-067) | Search from every cell to each ocean, O((m · n)²): re-walks the same paths | Reverse flow: multi-source DFS from each ocean's border; one `seen` grid per ocean | O(m · n) / O(m · n) |
| [algo-068 Clone Graph](../practice/live-coding/03-algorithms.md#algo-068) | Recursive copy without a map: duplicates nodes, loops forever on cycles | Map original → copy, inserted before cloning neighbours | O(V + E) / O(V) |
| [algo-069 Course Schedule](../practice/live-coding/03-algorithms.md#algo-069) | Rescan all courses each round for one with no unmet prereqs, O(V · (V + E)) | Remaining in-degree per course (Kahn); processed count < n means cycle | O(V + E) / O(V + E) |
| [algo-070 Course Schedule II](../practice/live-coding/03-algorithms.md#algo-070) | Rescan every course for one whose prereqs are taken, O(V · (V + E)) | In-degrees; dequeue order is the answer; edges pre → course | O(V + E) / O(V + E) |
| [algo-071 Rotting Oranges](../practice/live-coding/03-algorithms.md#algo-071) | BFS from each rotten orange, or simulate minute by minute, O((m · n)²) | One multi-source BFS, one layer per minute, plus a fresh count | O(m · n) / O(m · n) |
| [algo-072 Network Delay Time](../practice/live-coding/03-algorithms.md#algo-072) | Bellman-Ford, O(V · E), only needed for negative weights; plain BFS is wrong | Min-heap of tentative distances (Dijkstra); skip stale entries | O(E log E) / O(V + E) |
| [algo-073 Number of Connected Components in an Undirected Graph](../practice/live-coding/03-algorithms.md#algo-073) | Fresh BFS/DFS per edge or query: re-walks the same components | Union-find roots; count drops on each real merge | O(n + E · α(n)) / O(n) |
| [algo-074 Word Ladder](../practice/live-coding/03-algorithms.md#algo-074) | Compare every pair of words to build edges, O(N² · L) | BFS; generate 26 · L neighbours, look up in a set, delete on enqueue | O(N · L · 26 · L) / O(N · L) |
| [algo-099 Alien Dictionary](../practice/live-coding/03-algorithms.md#algo-099) | Try every letter permutation and check sortedness, O(k! · total length) | First differing letter of adjacent words → edge; Kahn on in-degrees | O(C + V + E) / O(V + E) |

### Backtracking

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-075 Subsets](../practice/live-coding/03-algorithms.md#algo-075) | — output is all 2^n subsets; key is building each once | Start index: only add later elements; push a copy at every call | O(n · 2^n) / O(n) |
| [algo-076 Permutations](../practice/live-coding/03-algorithms.md#algo-076) | `current.includes` check per element: O(n) per check | A `used` array, reset when backtracking | O(n · n!) / O(n) |
| [algo-077 Combination Sum](../practice/live-coding/03-algorithms.md#algo-077) | Generate every multiset, then filter by sum: explores branches already over target | Sorted candidates and start index i (reuse allowed); break when too big | O(n^(T/m)) / O(T/m) |
| [algo-078 Generate Parentheses](../practice/live-coding/03-algorithms.md#algo-078) | Generate all 2^(2n) strings, filter balanced ones | Open and close counts: `(` while open < n, `)` while close < open | O(4^n / √n) / O(n) |
| [algo-079 Word Search](../practice/live-coding/03-algorithms.md#algo-079) | Collect every board path and compare: explores already-mismatched paths | DFS one char per step; mark cell on path, restore on return | O(m · n · 3^L) / O(L) |

### Dynamic programming

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-080 Longest Increasing Path in a Matrix](../practice/live-coding/03-algorithms.md#algo-080) | DFS from every cell, exponential: recomputes longest path from each cell | Strictly increasing → no cycles; `memo[r][c]` = best path from that cell | O(m · n) / O(m · n) |
| [algo-081 Climbing Stairs](../practice/live-coding/03-algorithms.md#algo-081) | Plain recursion, O(2^n): recomputes the same subproblems | ways(n) = ways(n−1) + ways(n−2); keep last two values | O(n) / O(1) |
| [algo-082 House Robber](../practice/live-coding/03-algorithms.md#algo-082) | Every non-adjacent subset, O(2^n) | best(i) = max(best(i−1), best(i−2) + nums[i]); last two values | O(n) / O(1) |
| [algo-084 Coin Change](../practice/live-coding/03-algorithms.md#algo-084) | Plain recursion, exponential; greedy biggest-coin fails ([1,3,4], 6) | dp[a] = 1 + min(dp[a − coin]); init Infinity, dp[0] = 0 | O(amount · coins) / O(amount) |
| [algo-085 Longest Increasing Subsequence](../practice/live-coding/03-algorithms.md#algo-085) | dp[i] = 1 + max over earlier smaller dp[j], O(n²) | `tails[k]` = smallest tail of length k + 1; lower-bound replace | O(n log n) / O(n) |
| [algo-086 Longest Common Subsequence](../practice/live-coding/03-algorithms.md#algo-086) | Enumerate 2^m subsequences | dp[i][j] over prefixes: match → diagonal + 1, else max of drop either | O(m · n) / O(n) |
| [algo-087 Word Break](../practice/live-coding/03-algorithms.md#algo-087) | Recursion tries every split repeatedly, exponential; greedy longest-match fails | dp[i] = some j with dp[j] true and s[j..i) a word; dp[0] true | O(n²) checks / O(n) |
| [algo-088 Unique Paths](../practice/live-coding/03-algorithms.md#algo-088) | Recursion without memo, exponential | paths = above + left; one rolling row (or C(m+n−2, m−1)) | O(m · n) / O(n) |
| [algo-089 Edit Distance](../practice/live-coding/03-algorithms.md#algo-089) | Recursion branching three ways, exponential | dp[i][j] over prefixes: match → diagonal, else 1 + min(replace, delete, insert) | O(m · n) / O(n) |
| [algo-090 Partition Equal Subset Sum](../practice/live-coding/03-algorithms.md#algo-090) | Try all subsets, O(2^n) | Reachable sums up to total / 2; iterate sums high to low | O(n · target) / O(target) |
| [algo-091 Maximum Subarray](../practice/live-coding/03-algorithms.md#algo-091) | All subarrays, O(n²) (O(n³) if sums recomputed) | Best sum ending here: extend or restart; plus overall best (Kadane) | O(n) / O(1) |
| [algo-092 Decode Ways](../practice/live-coding/03-algorithms.md#algo-092) | Plain recursion, exponential | ways(i) from one digit (not '0') + two digits (10–26); two variables | O(n) / O(1) |

### Greedy

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-065 Task Scheduler](../practice/live-coding/03-algorithms.md#algo-065) | Simulate slot by slot, redoing the same choice each slot | Max count and how many tie: max(n_tasks, (maxCount − 1)(n + 1) + ties) | O(N) / O(1) |
| [algo-093 Jump Game](../practice/live-coding/03-algorithms.md#algo-093) | DP/backtracking over every jump, O(n²) or worse | Farthest reachable index; stuck if i passes it | O(n) / O(1) |

### Trie

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-096 Implement Trie (Prefix Tree)](../practice/live-coding/03-algorithms.md#algo-096) | Set of words: prefix query scans every word, O(N · L) | Nodes char → child plus `isWord` flag; search and startsWith share one walk | O(L) per op / O(total chars) |
| [algo-097 Word Search II](../practice/live-coding/03-algorithms.md#algo-097) | Word Search per word, O(W · m · n · 3^L): shared prefixes re-walked | Trie of all words walked alongside the board; prune exhausted leaves | O(m · n · 4 · 3^(L−1)) / O(total letters) |

### Bits & math

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-098 Single Number](../practice/live-coding/03-algorithms.md#algo-098) | Count map/set, O(n) space; or sort, O(n log n) | One XOR accumulator: pairs cancel, single number remains | O(n) / O(1) |

### Design

| Drill | Brute force (cost) and what it recomputes | What you remember instead | Result |
|---|---|---|---|
| [algo-100 LRU Cache](../practice/live-coding/03-algorithms.md#algo-100) | List with timestamps: scan everything to evict, O(n) | Ordered Map (or hash map + doubly linked list); re-insert on access, evict first | O(1) per op / O(capacity) |

---

## 9. Edge cases to test before saying "done"

- empty input, one element, two elements
- all equal values; duplicates
- already sorted; reverse sorted
- negatives and zero (break sliding window on sums; break "multiply" logic)
- answer at the very first / very last position
- no valid answer (what do you return?)
- very large values (integer overflow is rare in JS, but `>>` and `|` truncate to 32-bit; `Number.MAX_SAFE_INTEGER` is 2⁵³ − 1)
- strings: uppercase vs lowercase, spaces, Unicode (use `for…of`, not indexes)
- trees: empty tree, single node, a skewed tree (recursion depth)
- graphs: disconnected parts, cycles, self-loops

---

## 10. How to practise so it sticks

- For every problem, write the **three lines** from section 1 (brute force / repeated / remember) in the editor **before** any code. That is the skill interviews test; the code follows from it.
- Mix patterns (the drills page's Session mode does this). Solving ten sliding-window problems in a row trains recognition of the *section title*, not of the problem.
- Re-solve from a blank editor after 1 day and after 3–4 days. Anything you can't restart is not learned yet; mark it "redo".
- When stuck for 10+ minutes: write and run the brute force, then look at its inner loop and ask section 1's question. A working brute force at minute 20 beats a broken clever solution at minute 50.
