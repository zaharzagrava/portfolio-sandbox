# Algorithm live-coding drills

100 problems most likely to come up in Full Stack Node.js live-coding rounds. Try each one before opening the solution. Every solution was run against the tests shown.

Difficulty: Easy 30 · Medium 62 · Hard 8

## Index

| # | Problem | Topic | Level |
|---|---|---|---|
| algo-001 | [Two Sum](#algo-001) | Hash map | Easy |
| algo-002 | [Contains Duplicate](#algo-002) | Hash set | Easy |
| algo-003 | [Valid Anagram](#algo-003) | Frequency count | Easy |
| algo-004 | [Group Anagrams](#algo-004) | Hash map grouping | Medium |
| algo-005 | [Top K Frequent Elements](#algo-005) | Bucket sort | Medium |
| algo-006 | [Product of Array Except Self](#algo-006) | Prefix/suffix products | Medium |
| algo-007 | [Longest Consecutive Sequence](#algo-007) | Hash set | Medium |
| algo-008 | [Majority Element](#algo-008) | Boyer-Moore voting | Easy |
| algo-009 | [Encode and Decode Strings](#algo-009) | String encoding | Medium |
| algo-010 | [Valid Palindrome](#algo-010) | Two pointers | Easy |
| algo-011 | [Two Sum II (Sorted Input)](#algo-011) | Two pointers | Medium |
| algo-012 | [3Sum](#algo-012) | Two pointers | Medium |
| algo-013 | [Container With Most Water](#algo-013) | Two pointers | Medium |
| algo-014 | [Trapping Rain Water](#algo-014) | Two pointers | Hard |
| algo-015 | [Move Zeroes](#algo-015) | Two pointers | Easy |
| algo-016 | [Best Time to Buy and Sell Stock](#algo-016) | Sliding window | Easy |
| algo-017 | [Longest Substring Without Repeating Characters](#algo-017) | Sliding window | Medium |
| algo-018 | [Longest Repeating Character Replacement](#algo-018) | Sliding window | Medium |
| algo-019 | [Permutation in String](#algo-019) | Sliding window | Medium |
| algo-020 | [Minimum Window Substring](#algo-020) | Sliding window | Hard |
| algo-021 | [Sliding Window Maximum](#algo-021) | Monotonic deque | Hard |
| algo-022 | [Valid Parentheses](#algo-022) | Stack | Easy |
| algo-023 | [Min Stack](#algo-023) | Stack | Medium |
| algo-024 | [Evaluate Reverse Polish Notation](#algo-024) | Stack | Medium |
| algo-025 | [Daily Temperatures](#algo-025) | Monotonic stack | Medium |
| algo-026 | [Largest Rectangle in Histogram](#algo-026) | Monotonic stack | Hard |
| algo-027 | [Binary Search](#algo-027) | Binary search | Easy |
| algo-028 | [Search a 2D Matrix](#algo-028) | Binary search | Medium |
| algo-029 | [Koko Eating Bananas](#algo-029) | Binary search on answer | Medium |
| algo-030 | [Find Minimum in Rotated Sorted Array](#algo-030) | Binary search | Medium |
| algo-031 | [Search in Rotated Sorted Array](#algo-031) | Binary search | Medium |
| algo-032 | [Find First and Last Position of Element](#algo-032) | Binary search | Medium |
| algo-033 | [Reverse Linked List](#algo-033) | Linked list | Easy |
| algo-034 | [Merge Two Sorted Lists](#algo-034) | Linked list | Easy |
| algo-035 | [Linked List Cycle](#algo-035) | Fast & slow pointers | Easy |
| algo-036 | [Remove Nth Node From End of List](#algo-036) | Two pointers (gap) | Medium |
| algo-037 | [Reorder List](#algo-037) | Linked list | Medium |
| algo-038 | [Add Two Numbers](#algo-038) | Linked list | Medium |
| algo-039 | [Merge Intervals](#algo-039) | Intervals | Medium |
| algo-040 | [Insert Interval](#algo-040) | Intervals | Medium |
| algo-041 | [Non-overlapping Intervals](#algo-041) | Intervals (greedy) | Medium |
| algo-042 | [Meeting Rooms II](#algo-042) | Intervals (sweep line) | Medium |
| algo-043 | [Subarray Sum Equals K](#algo-043) | Prefix sum + hash map | Medium |
| algo-044 | [Range Sum Query (Immutable)](#algo-044) | Prefix sum | Easy |
| algo-045 | [Longest Common Prefix](#algo-045) | Strings | Easy |
| algo-046 | [String Compression](#algo-046) | Run-length encoding | Easy |
| algo-047 | [Valid Palindrome II](#algo-047) | Two pointers | Easy |
| algo-048 | [Isomorphic Strings](#algo-048) | Hash map | Easy |
| algo-049 | [Roman to Integer](#algo-049) | Strings | Easy |
| algo-050 | [Find All Anagrams in a String](#algo-050) | Sliding window | Medium |
| algo-051 | [Maximum Depth of Binary Tree](#algo-051) | Trees (DFS) | Easy |
| algo-052 | [Invert Binary Tree](#algo-052) | Trees (DFS) | Easy |
| algo-053 | [Same Tree](#algo-053) | Trees (DFS) | Easy |
| algo-054 | [Subtree of Another Tree](#algo-054) | Trees (DFS) | Easy |
| algo-055 | [Binary Tree Level Order Traversal](#algo-055) | Trees (BFS) | Medium |
| algo-056 | [Validate Binary Search Tree](#algo-056) | Trees (BST) | Medium |
| algo-057 | [Lowest Common Ancestor of a BST](#algo-057) | Trees (BST) | Easy |
| algo-058 | [Kth Smallest Element in a BST](#algo-058) | Trees (BST) | Medium |
| algo-059 | [Diameter of Binary Tree](#algo-059) | Trees (DFS) | Easy |
| algo-060 | [Path Sum](#algo-060) | Trees (DFS) | Easy |
| algo-061 | [Kth Largest Element in an Array](#algo-061) | Heap / priority queue | Medium |
| algo-062 | [K Closest Points to Origin](#algo-062) | Heap / priority queue | Medium |
| algo-063 | [Merge k Sorted Lists](#algo-063) | Heap / priority queue | Hard |
| algo-064 | [Find Median from Data Stream](#algo-064) | Heap / two heaps | Hard |
| algo-065 | [Task Scheduler](#algo-065) | Greedy + heap | Medium |
| algo-066 | [Number of Islands](#algo-066) | Graphs (grid DFS/BFS) | Medium |
| algo-067 | [Max Area of Island](#algo-067) | Graphs (grid DFS/BFS) | Medium |
| algo-068 | [Clone Graph](#algo-068) | Graphs (DFS + hash map) | Medium |
| algo-069 | [Course Schedule](#algo-069) | Graphs (topological sort) | Medium |
| algo-070 | [Course Schedule II](#algo-070) | Graphs (topological sort) | Medium |
| algo-071 | [Rotting Oranges](#algo-071) | Graphs (multi-source BFS) | Medium |
| algo-072 | [Network Delay Time](#algo-072) | Graphs (Dijkstra) | Medium |
| algo-073 | [Number of Connected Components in an Undirected Graph](#algo-073) | Graphs (union-find) | Medium |
| algo-074 | [Word Ladder](#algo-074) | Graphs (BFS shortest path) | Hard |
| algo-075 | [Subsets](#algo-075) | Backtracking | Medium |
| algo-076 | [Permutations](#algo-076) | Backtracking | Medium |
| algo-077 | [Combination Sum](#algo-077) | Backtracking | Medium |
| algo-078 | [Generate Parentheses](#algo-078) | Backtracking | Medium |
| algo-079 | [Word Search](#algo-079) | Backtracking (grid DFS) | Medium |
| algo-080 | [Letter Combinations of a Phone Number](#algo-080) | Backtracking | Medium |
| algo-081 | [Climbing Stairs](#algo-081) | Dynamic programming (1D) | Easy |
| algo-082 | [House Robber](#algo-082) | Dynamic programming (1D) | Medium |
| algo-083 | [House Robber II](#algo-083) | Dynamic programming (1D) | Medium |
| algo-084 | [Coin Change](#algo-084) | Dynamic programming (unbounded knapsack) | Medium |
| algo-085 | [Longest Increasing Subsequence](#algo-085) | Dynamic programming (LIS / binary search) | Medium |
| algo-086 | [Longest Common Subsequence](#algo-086) | Dynamic programming (2D) | Medium |
| algo-087 | [Word Break](#algo-087) | Dynamic programming (1D) | Medium |
| algo-088 | [Unique Paths](#algo-088) | Dynamic programming (2D grid) | Medium |
| algo-089 | [Edit Distance](#algo-089) | Dynamic programming (2D) | Hard |
| algo-090 | [Partition Equal Subset Sum](#algo-090) | Dynamic programming (0/1 knapsack) | Medium |
| algo-091 | [Maximum Subarray](#algo-091) | Dynamic programming (Kadane) | Easy |
| algo-092 | [Decode Ways](#algo-092) | Dynamic programming (1D) | Medium |
| algo-093 | [Jump Game](#algo-093) | Greedy | Medium |
| algo-094 | [Gas Station](#algo-094) | Greedy | Medium |
| algo-095 | [Best Time to Buy and Sell Stock II](#algo-095) | Greedy | Easy |
| algo-096 | [Implement Trie (Prefix Tree)](#algo-096) | Trie | Medium |
| algo-097 | [Design Add and Search Words Data Structure](#algo-097) | Trie + DFS | Medium |
| algo-098 | [Single Number](#algo-098) | Bit manipulation | Easy |
| algo-099 | [Counting Bits](#algo-099) | Bit manipulation + DP | Easy |
| algo-100 | [LRU Cache](#algo-100) | Design (hash map + ordering) | Medium |

---

<a id="algo-001"></a>
### algo-001. Two Sum

*Hash map · Easy*

Given an array of integers `nums` and an integer `target`, return the **indices** of the two numbers that add up to `target`. Exactly one solution exists, and you may not use the same element twice. Return the indices in increasing order.

```
twoSum([2, 7, 11, 15], 9)  -> [0, 1]
twoSum([3, 2, 4], 6)       -> [1, 2]
```

**Starter**

```ts
function twoSum(nums: number[], target: number): [number, number] {
  // TODO
  return [-1, -1];
}
```

<details>
<summary>Solution</summary>

```ts
function twoSum(nums: number[], target: number): [number, number] {
  const seen = new Map<number, number>(); // value -> index
  for (let i = 0; i < nums.length; i++) {
    const need = target - nums[i];
    const j = seen.get(need);
    if (j !== undefined) return [j, i];
    seen.set(nums[i], i);
  }
  throw new Error('No solution');
}
```

**Why it works.** Brute force checks every pair in O(n^2). Instead, walk the array once and store each value's index in a hash map; for each element, look up its complement `target - x` in O(1). Check the map before inserting the current value so an element never pairs with itself (e.g. [3,3] with target 6 still works). O(n) time, O(n) space.

**Say it.** I scan once and keep a map from value to index; for each number I check whether its complement was already seen, which gives O(n) time instead of checking all pairs.

**Follow-up.** Q: What if the array is sorted and you need O(1) extra space? A: Use two pointers from both ends: move the left pointer right if the sum is too small, the right pointer left if too big (Two Sum II).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(twoSum([2, 7, 11, 15], 9), [0, 1]);
assert.deepEqual(twoSum([3, 2, 4], 6), [1, 2]);
assert.deepEqual(twoSum([3, 3], 6), [0, 1]);
assert.deepEqual(twoSum([-1, -2, -3, -4, -5], -8), [2, 4]);
assert.throws(() => twoSum([1, 2], 10));
```

</details>

</details>

---

<a id="algo-002"></a>
### algo-002. Contains Duplicate

*Hash set · Easy*

Given an integer array `nums`, return `true` if any value appears **at least twice**, and `false` if every element is distinct.

```
containsDuplicate([1, 2, 3, 1])  -> true
containsDuplicate([1, 2, 3, 4])  -> false
```

**Starter**

```ts
function containsDuplicate(nums: number[]): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
function containsDuplicate(nums: number[]): boolean {
  const seen = new Set<number>();
  for (const x of nums) {
    if (seen.has(x)) return true;
    seen.add(x);
  }
  return false;
}
```

**Why it works.** Brute force compares all pairs in O(n^2); sorting first gives O(n log n) time and O(1) extra space. The optimal approach adds each value to a Set and returns as soon as a value is already present. O(n) time, O(n) space. A one-liner `new Set(nums).size !== nums.length` also works but cannot exit early.

**Say it.** I put each number into a hash set and return true the moment I see one that is already there, so it is a single O(n) pass.

**Follow-up.** Q: What if memory is very tight? A: Sort in place and compare neighbours: O(n log n) time, O(1) extra space (but it mutates the input).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(containsDuplicate([1, 2, 3, 1]), true);
assert.equal(containsDuplicate([1, 2, 3, 4]), false);
assert.equal(containsDuplicate([]), false);
assert.equal(containsDuplicate([1, 1, 1, 3, 3, 4, 3, 2, 4, 2]), true);
assert.equal(containsDuplicate([-1, 0, 1]), false);
```

</details>

</details>

---

<a id="algo-003"></a>
### algo-003. Valid Anagram

*Frequency count · Easy*

Given two strings `s` and `t`, return `true` if `t` is an anagram of `s` (same characters with the same counts, in any order).

```
isAnagram("anagram", "nagaram") -> true
isAnagram("rat", "car")         -> false
```

**Starter**

```ts
function isAnagram(s: string, t: string): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
function isAnagram(s: string, t: string): boolean {
  if (s.length !== t.length) return false;
  const count = new Map<string, number>();
  for (const ch of s) count.set(ch, (count.get(ch) ?? 0) + 1);
  for (const ch of t) {
    const c = count.get(ch);
    if (!c) return false; // missing or already used up
    count.set(ch, c - 1);
  }
  return true;
}
```

**Why it works.** Sorting both strings and comparing works in O(n log n). The optimal way counts characters of `s` in a map, then decrements for `t`; any missing or exhausted character means no anagram. Check lengths first so leftover counts cannot hide a mismatch. O(n) time, O(k) space where k is the alphabet size (O(1) for lowercase letters with a 26-slot array).

**Say it.** I count each character of the first string and decrement while reading the second; if a count would go negative or lengths differ, it is not an anagram.

**Follow-up.** Q: What about Unicode? A: Iterate with `for...of` (code points, not UTF-16 units) and use a Map instead of a 26-slot array; optionally normalize with `str.normalize()` first.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(isAnagram('anagram', 'nagaram'), true);
assert.equal(isAnagram('rat', 'car'), false);
assert.equal(isAnagram('', ''), true);
assert.equal(isAnagram('a', 'ab'), false);
assert.equal(isAnagram('aacc', 'ccac'), false);
```

</details>

</details>

---

<a id="algo-004"></a>
### algo-004. Group Anagrams

*Hash map grouping · Medium*

Given an array of strings `strs`, group the anagrams together. Return the groups in any order.

```
groupAnagrams(["eat","tea","tan","ate","nat","bat"])
  -> [["eat","tea","ate"],["tan","nat"],["bat"]]
groupAnagrams([""]) -> [[""]]
```

**Starter**

```ts
function groupAnagrams(strs: string[]): string[][] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
function groupAnagrams(strs: string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const s of strs) {
    // Key = letter counts, e.g. "1#0#0#...": O(len) instead of sorting
    const counts = new Array(26).fill(0);
    for (let i = 0; i < s.length; i++) counts[s.charCodeAt(i) - 97]++;
    const key = counts.join('#');
    const group = groups.get(key);
    if (group) group.push(s);
    else groups.set(key, [s]);
  }
  return [...groups.values()];
}
```

**Why it works.** Brute force compares every pair of strings for anagram-ness, O(n^2 * k). Instead give every string a canonical key that is equal for all anagrams and bucket by it in a hash map. Sorting the letters as the key costs O(n * k log k); a 26-letter count signature costs O(n * k). Use a separator in the count key, otherwise counts like 1,11 and 11,1 collide. O(n * k) time, O(n * k) space.

**Say it.** Anagrams share the same letter counts, so I build a count signature for each word and use it as a hash map key to collect the groups in one pass.

**Follow-up.** Q: Sorted-string key or count key? A: Sorted key is simpler and fine for short words (O(k log k)); the count key is O(k) and better for long strings over a small alphabet.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const norm = (g: string[][]) => g.map((x) => [...x].sort()).sort((a, b) => a.join().localeCompare(b.join()));
assert.deepEqual(
  norm(groupAnagrams(['eat', 'tea', 'tan', 'ate', 'nat', 'bat'])),
  norm([['eat', 'tea', 'ate'], ['tan', 'nat'], ['bat']]),
);
assert.deepEqual(groupAnagrams(['']), [['']]);
assert.deepEqual(groupAnagrams(['a']), [['a']]);
assert.equal(groupAnagrams(['ab', 'ba', 'abc', 'cab', 'x']).length, 3);
assert.deepEqual(groupAnagrams([]), []);
```

</details>

</details>

---

<a id="algo-005"></a>
### algo-005. Top K Frequent Elements

*Bucket sort · Medium*

Given an integer array `nums` and an integer `k`, return the `k` most frequent elements (any order). The answer is guaranteed to be unique. Aim for better than O(n log n).

```
topKFrequent([1,1,1,2,2,3], 2) -> [1, 2]
topKFrequent([1], 1)           -> [1]
```

**Starter**

```ts
function topKFrequent(nums: number[], k: number): number[] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
function topKFrequent(nums: number[], k: number): number[] {
  const freq = new Map<number, number>();
  for (const x of nums) freq.set(x, (freq.get(x) ?? 0) + 1);

  // buckets[c] holds all values that appear exactly c times (c <= n)
  const buckets: number[][] = Array.from({ length: nums.length + 1 }, () => []);
  for (const [value, count] of freq) buckets[count].push(value);

  const result: number[] = [];
  for (let c = buckets.length - 1; c > 0 && result.length < k; c--) {
    for (const value of buckets[c]) {
      result.push(value);
      if (result.length === k) break;
    }
  }
  return result;
}
```

**Why it works.** Count frequencies with a hash map. Sorting the entries by count is O(n log n), and a size-k min-heap is O(n log k). Because a frequency can never exceed n, you can bucket values by frequency in an array of n+1 lists and read buckets from highest to lowest until you have k values. O(n) time, O(n) space.

**Say it.** I count frequencies, then bucket values by their count, since counts are bounded by n, and walk the buckets from the top until I have k elements, which is linear time.

**Follow-up.** Q: What if the data is a huge stream? A: Keep counts and a min-heap of size k (O(n log k)), or use an approximate sketch like Count-Min plus a heap when counts do not fit in memory.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
assert.deepEqual(sorted(topKFrequent([1, 1, 1, 2, 2, 3], 2)), [1, 2]);
assert.deepEqual(topKFrequent([1], 1), [1]);
assert.deepEqual(sorted(topKFrequent([4, 4, 5, 5, 5, 6, -1, -1, -1, -1], 3)), [-1, 4, 5]);
assert.deepEqual(sorted(topKFrequent([7, 8, 9], 3)), [7, 8, 9]);
```

</details>

</details>

---

<a id="algo-006"></a>
### algo-006. Product of Array Except Self

*Prefix/suffix products · Medium*

Given an integer array `nums`, return an array `answer` where `answer[i]` is the product of all elements except `nums[i]`. Do it in O(n) **without using division**.

```
productExceptSelf([1, 2, 3, 4])      -> [24, 12, 8, 6]
productExceptSelf([-1, 1, 0, -3, 3]) -> [0, 0, 9, 0, 0]
```

**Starter**

```ts
function productExceptSelf(nums: number[]): number[] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
function productExceptSelf(nums: number[]): number[] {
  const n = nums.length;
  const answer = new Array<number>(n).fill(1);
  let prefix = 1;
  for (let i = 0; i < n; i++) {
    answer[i] = prefix; // product of everything left of i
    prefix *= nums[i];
  }
  let suffix = 1;
  for (let i = n - 1; i >= 0; i--) {
    answer[i] *= suffix; // times product of everything right of i
    suffix *= nums[i];
  }
  return answer;
}
```

**Why it works.** Brute force multiplies all other elements for each index, O(n^2). Division fails with zeros and is disallowed. The answer at i is (product of everything left) * (product of everything right), so one left-to-right pass writes prefix products into the output and one right-to-left pass multiplies in a running suffix product. O(n) time, O(1) extra space besides the output.

**Say it.** Each answer is the prefix product times the suffix product, so I fill the output with prefix products in one pass and multiply by a running suffix product in a second pass.

**Follow-up.** Q: Why not total product divided by nums[i]? A: Zeros break it (division by zero, and with two zeros everything is 0), and the interviewer forbids division; prefix/suffix handles zeros naturally.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const fix = (a: number[]) => a.map((x) => (x === 0 ? 0 : x)); // normalize -0
assert.deepEqual(productExceptSelf([1, 2, 3, 4]), [24, 12, 8, 6]);
assert.deepEqual(fix(productExceptSelf([-1, 1, 0, -3, 3])), [0, 0, 9, 0, 0]);
assert.deepEqual(productExceptSelf([2, 3]), [3, 2]);
assert.deepEqual(fix(productExceptSelf([0, 0, 2])), [0, 0, 0]);
```

</details>

</details>

---

<a id="algo-007"></a>
### algo-007. Longest Consecutive Sequence

*Hash set · Medium*

Given an unsorted integer array `nums`, return the length of the longest run of consecutive integers (values, not positions). Must run in O(n).

```
longestConsecutive([100, 4, 200, 1, 3, 2])        -> 4   // 1,2,3,4
longestConsecutive([0,3,7,2,5,8,4,6,0,1])         -> 9
```

**Starter**

```ts
function longestConsecutive(nums: number[]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function longestConsecutive(nums: number[]): number {
  const set = new Set(nums);
  let best = 0;
  for (const x of set) {
    if (set.has(x - 1)) continue; // not the start of a run
    let length = 1;
    while (set.has(x + length)) length++;
    best = Math.max(best, length);
  }
  return best;
}
```

**Why it works.** Sorting and scanning gives O(n log n). For O(n), put all numbers in a Set and only start counting from numbers that begin a run (x - 1 is not in the set), then extend upward. Each number is visited by an inner loop at most once overall, so the total work is linear. Iterate over the Set, not the array, so duplicates do not repeat work. O(n) time, O(n) space.

**Say it.** I load everything into a set and only expand from numbers whose predecessor is missing, so each sequence is walked exactly once and the whole thing is O(n).

**Follow-up.** Q: Why is the nested while loop still O(n)? A: The inner loop only runs from a sequence start, and the sequences are disjoint, so the total number of inner steps across all starts is at most n.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(longestConsecutive([100, 4, 200, 1, 3, 2]), 4);
assert.equal(longestConsecutive([0, 3, 7, 2, 5, 8, 4, 6, 0, 1]), 9);
assert.equal(longestConsecutive([]), 0);
assert.equal(longestConsecutive([1, 2, 0, 1]), 3);
assert.equal(longestConsecutive([-3, -2, -1, 10]), 3);
```

</details>

</details>

---

<a id="algo-008"></a>
### algo-008. Majority Element

*Boyer-Moore voting · Easy*

Given an array `nums` of size n, return the majority element: the value that appears **more than n/2 times**. It always exists. Can you do it in O(n) time and O(1) space?

```
majorityElement([3, 2, 3])             -> 3
majorityElement([2, 2, 1, 1, 1, 2, 2]) -> 2
```

**Starter**

```ts
function majorityElement(nums: number[]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function majorityElement(nums: number[]): number {
  let candidate = nums[0];
  let count = 0;
  for (const x of nums) {
    if (count === 0) candidate = x;
    count += x === candidate ? 1 : -1;
  }
  return candidate;
}
```

**Why it works.** A hash map of counts is O(n) time but O(n) space; sorting and taking the middle is O(n log n). Boyer-Moore voting keeps one candidate and a counter: matching values add a vote, others cancel one. Because the majority has more than half of all votes, it cannot be fully cancelled and is the survivor. O(n) time, O(1) space. Trap: if the majority is not guaranteed, you must do a second pass to verify the candidate.

**Say it.** I use Boyer-Moore voting: pair off each majority vote against a different value; since the majority has more than half, it is the candidate left standing.

**Follow-up.** Q: What if a majority might not exist? A: Run a second pass counting the candidate and return it only if its count is greater than n/2.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(majorityElement([3, 2, 3]), 3);
assert.equal(majorityElement([2, 2, 1, 1, 1, 2, 2]), 2);
assert.equal(majorityElement([7]), 7);
assert.equal(majorityElement([1, 5, 5, 1, 5]), 5);
assert.equal(majorityElement([-1, -1, 2]), -1);
```

</details>

</details>

---

<a id="algo-009"></a>
### algo-009. Encode and Decode Strings

*String encoding · Medium*

Design `encode(strs: string[]): string` and `decode(s: string): string[]` so that `decode(encode(x))` returns the original list. Strings may contain **any characters**, including your delimiter.

```
decode(encode(["lint","code","love","you"])) -> ["lint","code","love","you"]
decode(encode(["", "a#b", "#"]))            -> ["", "a#b", "#"]
```

**Starter**

```ts
function encode(strs: string[]): string {
  // TODO
  return '';
}

function decode(s: string): string[] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
// Format: "<length>#<string>" for each string, e.g. ["ab","#"] -> "2#ab1##"
function encode(strs: string[]): string {
  return strs.map((s) => `${s.length}#${s}`).join('');
}

function decode(s: string): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < s.length) {
    const hash = s.indexOf('#', i);
    const length = Number(s.slice(i, hash));
    result.push(s.slice(hash + 1, hash + 1 + length));
    i = hash + 1 + length;
  }
  return result;
}
```

**Why it works.** A plain delimiter (join with ",") breaks as soon as a string contains the delimiter, and escaping is fiddly. Length-prefixing fixes it: write each string as its length, a '#', then the raw string. The decoder reads digits up to the first '#', then jumps exactly that many characters, so content is never interpreted. O(n) time and space for total length n. Trap: the length prefix must be parsed before the separator, not by splitting on '#'.

**Say it.** I prefix every string with its length and a separator, so the decoder reads the length and slices exactly that many characters, which is safe for any content.

**Follow-up.** Q: Why not JSON.stringify? A: It works in practice, but the interviewer wants the framing idea; length-prefixing is also how binary protocols (HTTP chunked encoding, TLV) frame messages.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const roundTrip = (x: string[]) => decode(encode(x));
assert.deepEqual(roundTrip(['lint', 'code', 'love', 'you']), ['lint', 'code', 'love', 'you']);
assert.deepEqual(roundTrip(['', 'a#b', '#']), ['', 'a#b', '#']);
assert.deepEqual(roundTrip([]), []);
assert.deepEqual(roundTrip(['12#34', '9#', 'x'.repeat(15)]), ['12#34', '9#', 'x'.repeat(15)]);
assert.deepEqual(roundTrip(['']), ['']);
```

</details>

</details>

---

<a id="algo-010"></a>
### algo-010. Valid Palindrome

*Two pointers · Easy*

A phrase is a palindrome if, after lowercasing and removing all non-alphanumeric characters, it reads the same forward and backward. Given a string `s`, return `true` if it is a palindrome.

```
isPalindrome("A man, a plan, a canal: Panama") -> true
isPalindrome("race a car")                     -> false
isPalindrome(" ")                              -> true
```

**Starter**

```ts
function isPalindrome(s: string): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
function isAlphaNum(ch: string): boolean {
  return /[a-z0-9]/i.test(ch);
}

function isPalindrome(s: string): boolean {
  let left = 0;
  let right = s.length - 1;
  while (left < right) {
    if (!isAlphaNum(s[left])) left++;
    else if (!isAlphaNum(s[right])) right--;
    else {
      if (s[left].toLowerCase() !== s[right].toLowerCase()) return false;
      left++;
      right--;
    }
  }
  return true;
}
```

**Why it works.** The easy version builds a cleaned, lowercased copy and compares it with its reverse: O(n) time but O(n) extra space. Two pointers from both ends skip non-alphanumeric characters and compare case-insensitively in place, giving O(n) time and O(1) space. Trap: forgetting that digits count, or comparing before skipping punctuation.

**Say it.** I move two pointers inward from both ends, skipping anything that is not a letter or digit, and compare characters case-insensitively; any mismatch means false.

**Follow-up.** Q: What if you may delete at most one character? A: On the first mismatch, try skipping either the left or the right character and check whether the remaining range is a palindrome (Valid Palindrome II).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(isPalindrome('A man, a plan, a canal: Panama'), true);
assert.equal(isPalindrome('race a car'), false);
assert.equal(isPalindrome(' '), true);
assert.equal(isPalindrome('0P'), false);
assert.equal(isPalindrome('ab_a'), true);
```

</details>

</details>

---

<a id="algo-011"></a>
### algo-011. Two Sum II (Sorted Input)

*Two pointers · Medium*

Given a **1-indexed** array `numbers` sorted in non-decreasing order, find two numbers that add up to `target` and return their indices `[index1, index2]` (index1 < index2). Exactly one solution exists. Use only O(1) extra space.

```
twoSumSorted([2, 7, 11, 15], 9) -> [1, 2]
twoSumSorted([2, 3, 4], 6)      -> [1, 3]
```

**Starter**

```ts
function twoSumSorted(numbers: number[], target: number): [number, number] {
  // TODO
  return [-1, -1];
}
```

<details>
<summary>Solution</summary>

```ts
function twoSumSorted(numbers: number[], target: number): [number, number] {
  let left = 0;
  let right = numbers.length - 1;
  while (left < right) {
    const sum = numbers[left] + numbers[right];
    if (sum === target) return [left + 1, right + 1];
    if (sum < target) left++;
    else right--;
  }
  throw new Error('No solution');
}
```

**Why it works.** A hash map works in O(n) time but uses O(n) space and ignores the sorting; binary search per element is O(n log n). With two pointers at both ends: if the sum is too small, only moving left rightward can increase it; if too big, only moving right leftward can decrease it. Each step safely discards one element, so O(n) time, O(1) space. Remember the answer is 1-indexed.

**Say it.** Because the array is sorted, I start pointers at both ends and move the left one up when the sum is too small and the right one down when it is too big.

**Follow-up.** Q: Why can't moving a pointer skip the answer? A: If sum < target, numbers[left] plus any element at or left of right is too small, so left can never be part of the answer; the symmetric argument holds for right.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(twoSumSorted([2, 7, 11, 15], 9), [1, 2]);
assert.deepEqual(twoSumSorted([2, 3, 4], 6), [1, 3]);
assert.deepEqual(twoSumSorted([-1, 0], -1), [1, 2]);
assert.deepEqual(twoSumSorted([1, 2, 3, 4, 4, 9, 56, 90], 8), [4, 5]);
```

</details>

</details>

---

<a id="algo-012"></a>
### algo-012. 3Sum

*Two pointers · Medium*

Given an integer array `nums`, return all **unique** triplets `[a, b, c]` with `a + b + c = 0`. The result must not contain duplicate triplets (order does not matter).

```
threeSum([-1, 0, 1, 2, -1, -4]) -> [[-1, -1, 2], [-1, 0, 1]]
threeSum([0, 1, 1])             -> []
threeSum([0, 0, 0])             -> [[0, 0, 0]]
```

**Starter**

```ts
function threeSum(nums: number[]): number[][] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
function threeSum(nums: number[]): number[][] {
  const a = [...nums].sort((x, y) => x - y);
  const result: number[][] = [];
  for (let i = 0; i < a.length - 2; i++) {
    if (a[i] > 0) break; // smallest is positive: no more zero sums
    if (i > 0 && a[i] === a[i - 1]) continue; // skip duplicate first values
    let left = i + 1;
    let right = a.length - 1;
    while (left < right) {
      const sum = a[i] + a[left] + a[right];
      if (sum < 0) left++;
      else if (sum > 0) right--;
      else {
        result.push([a[i], a[left], a[right]]);
        left++;
        right--;
        while (left < right && a[left] === a[left - 1]) left++; // skip duplicate second values
      }
    }
  }
  return result;
}
```

**Why it works.** Brute force tries all triples in O(n^3) and needs a set to remove duplicates. Sort first, fix the first element, then run Two Sum II with two pointers on the rest, giving O(n^2). Duplicates are avoided by skipping equal neighbours for the first element and, after a hit, for the left pointer. O(n^2) time, O(n) space for the sorted copy (O(1) extra if sorting in place). Trap: use a numeric comparator; the default sort compares strings.

**Say it.** I sort, fix each first number, and run a two-pointer search for the remaining pair; skipping equal neighbours prevents duplicate triplets, giving O(n^2).

**Follow-up.** Q: How would you generalize to 4Sum / kSum? A: Recursively fix one element and reduce to (k-1)Sum, with two pointers as the base case: O(n^(k-1)) time.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const norm = (r: number[][]) => r.map((t) => [...t].sort((x, y) => x - y).join(',')).sort();
assert.deepEqual(norm(threeSum([-1, 0, 1, 2, -1, -4])), norm([[-1, -1, 2], [-1, 0, 1]]));
assert.deepEqual(threeSum([0, 1, 1]), []);
assert.deepEqual(threeSum([0, 0, 0, 0]), [[0, 0, 0]]);
assert.deepEqual(norm(threeSum([-2, 0, 1, 1, 2])), norm([[-2, 0, 2], [-2, 1, 1]]));
assert.deepEqual(threeSum([]), []);
```

</details>

</details>

---

<a id="algo-013"></a>
### algo-013. Container With Most Water

*Two pointers · Medium*

You are given an array `height` where `height[i]` is the height of a vertical line at position `i`. Choose two lines that, together with the x-axis, form a container holding the most water. Return the maximum area (`width * min(height)`).

```
maxArea([1, 8, 6, 2, 5, 4, 8, 3, 7]) -> 49
maxArea([1, 1])                      -> 1
```

**Starter**

```ts
function maxArea(height: number[]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function maxArea(height: number[]): number {
  let left = 0;
  let right = height.length - 1;
  let best = 0;
  while (left < right) {
    const area = (right - left) * Math.min(height[left], height[right]);
    best = Math.max(best, area);
    // Moving the taller line can never help: width shrinks and height is capped by the shorter one
    if (height[left] < height[right]) left++;
    else right--;
  }
  return best;
}
```

**Why it works.** Brute force checks every pair, O(n^2). Start with the widest container and move inward. The area is limited by the shorter line, so moving the taller pointer can only lose width without raising the cap; the only chance of improvement is to move the shorter one. Each step discards one line, so O(n) time, O(1) space.

**Say it.** I start with the widest pair and always move the shorter side inward, because the shorter line limits the area and keeping it can never produce a bigger container.

**Follow-up.** Q: How is this different from Trapping Rain Water? A: Here you pick just two lines and ignore everything between them; in Trapping Rain Water every bar holds water based on the max to its left and right.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(maxArea([1, 8, 6, 2, 5, 4, 8, 3, 7]), 49);
assert.equal(maxArea([1, 1]), 1);
assert.equal(maxArea([4, 3, 2, 1, 4]), 16);
assert.equal(maxArea([1, 2, 1]), 2);
assert.equal(maxArea([0, 0]), 0);
```

</details>

</details>

---

<a id="algo-014"></a>
### algo-014. Trapping Rain Water

*Two pointers · Hard*

Given `n` non-negative integers representing an elevation map where each bar has width 1, compute how much rain water is trapped after raining.

```
trap([0,1,0,2,1,0,1,3,2,1,2,1]) -> 6
trap([4,2,0,3,2,5])             -> 9
```

**Starter**

```ts
function trap(height: number[]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function trap(height: number[]): number {
  let left = 0;
  let right = height.length - 1;
  let leftMax = 0;
  let rightMax = 0;
  let water = 0;
  while (left < right) {
    if (height[left] < height[right]) {
      // Right side has a wall at least this tall, so leftMax decides the level here
      leftMax = Math.max(leftMax, height[left]);
      water += leftMax - height[left];
      left++;
    } else {
      rightMax = Math.max(rightMax, height[right]);
      water += rightMax - height[right];
      right--;
    }
  }
  return water;
}
```

**Why it works.** Water above bar i is min(maxLeft(i), maxRight(i)) - height[i]. Brute force recomputes both maxes per bar, O(n^2); precomputing prefix-max and suffix-max arrays gives O(n) time and O(n) space. Two pointers drop the arrays: always process the side with the lower bar, because the opposite side is guaranteed to have a wall at least that tall, so that side's running max alone determines the water level. O(n) time, O(1) space.

**Say it.** Water at each bar is bounded by the smaller of the tallest walls on each side; with two pointers I process the lower side, since its running max is the real limit, giving O(n) time and O(1) space.

**Follow-up.** Q: Can you solve it with a stack? A: Yes: a monotonic decreasing stack of indices; when a taller bar arrives, pop the bottom and add water bounded by the new bar and the new stack top, layer by layer. Also O(n).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(trap([0, 1, 0, 2, 1, 0, 1, 3, 2, 1, 2, 1]), 6);
assert.equal(trap([4, 2, 0, 3, 2, 5]), 9);
assert.equal(trap([]), 0);
assert.equal(trap([1, 2, 3, 4]), 0);
assert.equal(trap([5, 0, 5]), 5);
```

</details>

</details>

---

<a id="algo-015"></a>
### algo-015. Move Zeroes

*Two pointers · Easy*

Given an integer array `nums`, move all `0`s to the end **in place**, keeping the relative order of the non-zero elements. Return nothing; mutate the array.

```
nums = [0, 1, 0, 3, 12]  -> after moveZeroes(nums): [1, 3, 12, 0, 0]
nums = [0]               -> [0]
```

**Starter**

```ts
function moveZeroes(nums: number[]): void {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
function moveZeroes(nums: number[]): void {
  let write = 0; // next position for a non-zero value
  for (let read = 0; read < nums.length; read++) {
    if (nums[read] !== 0) {
      [nums[write], nums[read]] = [nums[read], nums[write]];
      write++;
    }
  }
}
```

**Why it works.** Copying non-zeros into a new array and padding with zeros is O(n) time but O(n) space, and the task requires in-place. Use a read pointer and a write pointer: every non-zero is swapped to the write position, which keeps non-zeros in order and naturally pushes zeros to the end. O(n) time, O(1) space. The same read/write pattern solves Remove Duplicates from Sorted Array (write when nums[read] !== nums[write - 1]).

**Say it.** I keep a write pointer for the next non-zero slot and swap each non-zero I read into it, so non-zeros stay in order and zeros end up at the back in one pass.

**Follow-up.** Q: How would you remove duplicates from a sorted array in place? A: Same two-pointer idea: keep write = 1 and copy nums[read] to nums[write++] whenever it differs from nums[write - 1]; return write as the new length.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const run = (a: number[]) => { moveZeroes(a); return a; };
assert.deepEqual(run([0, 1, 0, 3, 12]), [1, 3, 12, 0, 0]);
assert.deepEqual(run([0]), [0]);
assert.deepEqual(run([1, 2, 3]), [1, 2, 3]);
assert.deepEqual(run([0, 0, 1]), [1, 0, 0]);
assert.deepEqual(run([]), []);
```

</details>

</details>

---

<a id="algo-016"></a>
### algo-016. Best Time to Buy and Sell Stock

*Sliding window · Easy*

Given `prices` where `prices[i]` is a stock price on day `i`, choose one day to buy and a **later** day to sell. Return the maximum profit, or `0` if no profit is possible.

```
maxProfit([7, 1, 5, 3, 6, 4]) -> 5   // buy at 1, sell at 6
maxProfit([7, 6, 4, 3, 1])    -> 0
```

**Starter**

```ts
function maxProfit(prices: number[]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function maxProfit(prices: number[]): number {
  let minPrice = Infinity;
  let best = 0;
  for (const price of prices) {
    minPrice = Math.min(minPrice, price);
    best = Math.max(best, price - minPrice);
  }
  return best;
}
```

**Why it works.** Brute force tries every buy/sell pair, O(n^2). Instead scan once, tracking the cheapest price so far (the best buy day for any later sell day) and the best profit if you sell today. This is a window whose left edge jumps to a new minimum. O(n) time, O(1) space. Trap: you cannot sell before you buy, so taking global max minus global min is wrong.

**Say it.** I scan once keeping the lowest price seen so far; selling today against that minimum is the best possible trade ending today, and I keep the maximum.

**Follow-up.** Q: What if you can make unlimited transactions? A: Sum every positive day-to-day increase (prices[i] - prices[i-1] when positive): O(n).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(maxProfit([7, 1, 5, 3, 6, 4]), 5);
assert.equal(maxProfit([7, 6, 4, 3, 1]), 0);
assert.equal(maxProfit([]), 0);
assert.equal(maxProfit([2, 4, 1]), 2);
assert.equal(maxProfit([3, 2, 6, 5, 0, 3]), 4);
```

</details>

</details>

---

<a id="algo-017"></a>
### algo-017. Longest Substring Without Repeating Characters

*Sliding window · Medium*

Given a string `s`, return the length of the longest **substring** (contiguous) without repeating characters.

```
lengthOfLongestSubstring("abcabcbb") -> 3   // "abc"
lengthOfLongestSubstring("bbbbb")    -> 1
lengthOfLongestSubstring("pwwkew")   -> 3   // "wke"
```

**Starter**

```ts
function lengthOfLongestSubstring(s: string): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function lengthOfLongestSubstring(s: string): number {
  const lastIndex = new Map<string, number>();
  let left = 0;
  let best = 0;
  for (let right = 0; right < s.length; right++) {
    const prev = lastIndex.get(s[right]);
    // Jump past the previous copy, but never move the window backwards
    if (prev !== undefined && prev >= left) left = prev + 1;
    lastIndex.set(s[right], right);
    best = Math.max(best, right - left + 1);
  }
  return best;
}
```

**Why it works.** Brute force checks every substring for uniqueness, O(n^3) or O(n^2) with a set. A sliding window keeps the invariant "no repeats in s[left..right]": extend right one character at a time, and when the character was last seen inside the window, jump left just past that position. Storing last indices in a map makes each step O(1). O(n) time, O(k) space for k distinct characters. Trap: only jump if the previous index is >= left, otherwise the window would move backwards.

**Say it.** I grow a window to the right and remember where each character was last seen; on a repeat inside the window I jump the left edge just past it, tracking the max width.

**Follow-up.** Q: What if at most k distinct characters are allowed instead? A: Same window with a count map; while the map has more than k keys, shrink from the left, decrementing and deleting zero counts.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(lengthOfLongestSubstring('abcabcbb'), 3);
assert.equal(lengthOfLongestSubstring('bbbbb'), 1);
assert.equal(lengthOfLongestSubstring('pwwkew'), 3);
assert.equal(lengthOfLongestSubstring(''), 0);
assert.equal(lengthOfLongestSubstring('abba'), 2);
assert.equal(lengthOfLongestSubstring('dvdf'), 3);
```

</details>

</details>

---

<a id="algo-018"></a>
### algo-018. Longest Repeating Character Replacement

*Sliding window · Medium*

Given an uppercase string `s` and an integer `k`, you may change at most `k` characters to any other uppercase letter. Return the length of the longest substring containing a single repeated letter you can get.

```
characterReplacement("ABAB", 2)    -> 4
characterReplacement("AABABBA", 1) -> 4   // "AABA" -> "AAAA"
```

**Starter**

```ts
function characterReplacement(s: string, k: number): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function characterReplacement(s: string, k: number): number {
  const counts = new Array(26).fill(0);
  let left = 0;
  let maxFreq = 0; // highest single-letter count seen in any window
  let best = 0;
  for (let right = 0; right < s.length; right++) {
    const r = s.charCodeAt(right) - 65;
    counts[r]++;
    maxFreq = Math.max(maxFreq, counts[r]);
    // Characters to replace = window size - most frequent letter
    while (right - left + 1 - maxFreq > k) {
      counts[s.charCodeAt(left) - 65]--;
      left++;
    }
    best = Math.max(best, right - left + 1);
  }
  return best;
}
```

**Why it works.** Brute force checks every substring, O(n^2) or worse. A window is valid if (window length - count of its most frequent letter) <= k, because those other letters are the ones you replace. Expand right, and shrink left while the window is invalid. maxFreq never needs to decrease: a smaller maxFreq could never produce a longer answer than one already recorded. O(n) time, O(1) space (26 counters).

**Say it.** A window is fixable if its length minus its most common letter count is at most k, so I slide a window, shrinking whenever that check fails, and track the largest valid window.

**Follow-up.** Q: Why is it safe not to decrease maxFreq when shrinking? A: The answer only grows when a window has a higher maxFreq than before; a stale, too-high maxFreq can only keep the window the same size, never report a wrong larger answer.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(characterReplacement('ABAB', 2), 4);
assert.equal(characterReplacement('AABABBA', 1), 4);
assert.equal(characterReplacement('AAAA', 0), 4);
assert.equal(characterReplacement('ABCDE', 1), 2);
assert.equal(characterReplacement('', 3), 0);
```

</details>

</details>

---

<a id="algo-019"></a>
### algo-019. Permutation in String

*Sliding window · Medium*

Given strings `s1` and `s2` (lowercase letters), return `true` if `s2` contains a permutation of `s1` as a contiguous substring.

```
checkInclusion("ab", "eidbaooo") -> true   // "ba"
checkInclusion("ab", "eidboaoo") -> false
```

**Starter**

```ts
function checkInclusion(s1: string, s2: string): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
function checkInclusion(s1: string, s2: string): boolean {
  const n = s1.length;
  if (n > s2.length) return false;
  const need = new Array(26).fill(0);
  const window = new Array(26).fill(0);
  for (let i = 0; i < n; i++) {
    need[s1.charCodeAt(i) - 97]++;
    window[s2.charCodeAt(i) - 97]++;
  }
  let matches = 0; // letters whose counts are equal in both arrays
  for (let c = 0; c < 26; c++) if (need[c] === window[c]) matches++;

  const update = (c: number, delta: number) => {
    if (window[c] === need[c]) matches--;
    window[c] += delta;
    if (window[c] === need[c]) matches++;
  };

  for (let right = n; right < s2.length; right++) {
    if (matches === 26) return true;
    update(s2.charCodeAt(right) - 97, 1);
    update(s2.charCodeAt(right - n) - 97, -1);
  }
  return matches === 26;
}
```

**Why it works.** Brute force generates all permutations of s1 (factorial) or sorts every window, O(n * m log m). Since a permutation has the same letter counts, slide a fixed window of length |s1| over s2 and compare count arrays. Tracking how many of the 26 letters currently match makes each slide O(1) instead of O(26). O(n) time, O(1) space.

**Say it.** A permutation just means equal letter counts, so I slide a fixed-size window over s2, updating counts as characters enter and leave, and check whether all 26 counts match.

**Follow-up.** Q: How would you return all start indices instead of a boolean? A: Same window; record right - n + 1 every time matches === 26 (that is the Find All Anagrams problem).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(checkInclusion('ab', 'eidbaooo'), true);
assert.equal(checkInclusion('ab', 'eidboaoo'), false);
assert.equal(checkInclusion('adc', 'dcda'), true);
assert.equal(checkInclusion('abc', 'ab'), false);
assert.equal(checkInclusion('a', 'a'), true);
```

</details>

</details>

---

<a id="algo-020"></a>
### algo-020. Minimum Window Substring

*Sliding window · Hard*

Given strings `s` and `t`, return the **shortest substring** of `s` that contains every character of `t` (including duplicates). If none exists, return `""`. The answer is unique.

```
minWindow("ADOBECODEBANC", "ABC") -> "BANC"
minWindow("a", "aa")             -> ""
```

**Starter**

```ts
function minWindow(s: string, t: string): string {
  // TODO
  return '';
}
```

<details>
<summary>Solution</summary>

```ts
function minWindow(s: string, t: string): string {
  if (t.length === 0 || t.length > s.length) return '';
  const need = new Map<string, number>();
  for (const ch of t) need.set(ch, (need.get(ch) ?? 0) + 1);

  let missing = t.length; // characters of t still not covered by the window
  let left = 0;
  let bestStart = 0;
  let bestLen = Infinity;

  for (let right = 0; right < s.length; right++) {
    const ch = s[right];
    if (need.has(ch)) {
      if (need.get(ch)! > 0) missing--;
      need.set(ch, need.get(ch)! - 1); // may go negative = surplus
    }
    while (missing === 0) {
      if (right - left + 1 < bestLen) {
        bestLen = right - left + 1;
        bestStart = left;
      }
      const out = s[left];
      if (need.has(out)) {
        need.set(out, need.get(out)! + 1);
        if (need.get(out)! > 0) missing++;
      }
      left++;
    }
  }
  return bestLen === Infinity ? '' : s.slice(bestStart, bestStart + bestLen);
}
```

**Why it works.** Brute force checks every substring for coverage, O(n^2 * |t|) or worse. Use a variable sliding window: expand right until the window covers t (a single `missing` counter tells you in O(1)), then shrink left as far as possible while still valid, recording the smallest window. Counts can go negative to mark surplus characters, which is what lets the shrink step know when a removal breaks coverage. O(|s| + |t|) time, O(k) space for distinct characters.

**Say it.** I expand the right edge until the window contains all of t, then shrink from the left while it stays valid, recording the smallest window; a missing-count makes the validity check O(1).

**Follow-up.** Q: Why is this O(n) with a nested while loop? A: Both left and right only ever move forward, each at most n times, so the total work is O(n).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(minWindow('ADOBECODEBANC', 'ABC'), 'BANC');
assert.equal(minWindow('a', 'a'), 'a');
assert.equal(minWindow('a', 'aa'), '');
assert.equal(minWindow('aaflslflsldkalskaaa', 'aaa'), 'aaa');
assert.equal(minWindow('abc', ''), '');
assert.equal(minWindow('bba', 'ab'), 'ba');
```

</details>

</details>

---

<a id="algo-021"></a>
### algo-021. Sliding Window Maximum

*Monotonic deque · Hard*

Given an array `nums` and a window size `k`, a window slides from left to right one step at a time. Return the maximum of each window.

```
maxSlidingWindow([1,3,-1,-3,5,3,6,7], 3) -> [3,3,5,5,6,7]
maxSlidingWindow([1], 1)                 -> [1]
```

**Starter**

```ts
function maxSlidingWindow(nums: number[], k: number): number[] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
function maxSlidingWindow(nums: number[], k: number): number[] {
  // deque holds indices; their values are strictly decreasing from head to tail
  const deque: number[] = [];
  let head = 0; // index of the deque front (avoids O(n) Array.shift)
  const result: number[] = [];
  for (let i = 0; i < nums.length; i++) {
    if (head < deque.length && deque[head] <= i - k) head++; // front left the window
    while (deque.length > head && nums[deque[deque.length - 1]] <= nums[i]) deque.pop();
    deque.push(i);
    if (i >= k - 1) result.push(nums[deque[head]]);
  }
  return result;
}
```

**Why it works.** Brute force scans each window, O(n * k); a heap gives O(n log n). A monotonic deque stores indices whose values decrease from front to back: a new element pops every smaller element from the back (they can never be a maximum again while it is in the window), and the front is dropped once it slides out. The front is always the current max. Each index is pushed and popped once: O(n) time, O(k) space. In JS, avoid Array.shift (O(n)); use a head index.

**Say it.** I keep a deque of indices with decreasing values; smaller elements behind a new one are useless so I pop them, and the front is always the window max, giving O(n).

**Follow-up.** Q: What about a fixed window's maximum *sum* instead of max element? A: Simpler: keep a running sum, add nums[i] and subtract nums[i - k] each step, tracking the best: O(n) time, O(1) space.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(maxSlidingWindow([1, 3, -1, -3, 5, 3, 6, 7], 3), [3, 3, 5, 5, 6, 7]);
assert.deepEqual(maxSlidingWindow([1], 1), [1]);
assert.deepEqual(maxSlidingWindow([9, 8, 7, 6], 2), [9, 8, 7]);
assert.deepEqual(maxSlidingWindow([1, -1], 1), [1, -1]);
assert.deepEqual(maxSlidingWindow([4, 4, 4], 3), [4]);
```

</details>

</details>

---

<a id="algo-022"></a>
### algo-022. Valid Parentheses

*Stack · Easy*

Given a string `s` containing only `()[]{}`, return `true` if every bracket is closed by the same type, in the correct order.

```
isValid("()[]{}") -> true
isValid("([)]")   -> false
isValid("{[]}")   -> true
```

**Starter**

```ts
function isValid(s: string): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
function isValid(s: string): boolean {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  for (const ch of s) {
    if (ch in pairs) {
      if (stack.pop() !== pairs[ch]) return false;
    } else {
      stack.push(ch);
    }
  }
  return stack.length === 0;
}
```

**Why it works.** Repeatedly deleting "()", "[]", "{}" until nothing changes works but is O(n^2). A stack captures nesting: push openers, and on a closer the top must be the matching opener. The string is valid only if the stack ends empty. O(n) time, O(n) space. Traps: a closer with an empty stack, and leftover openers at the end.

**Say it.** I push opening brackets onto a stack and, for each closing bracket, pop and check it matches; at the end the stack must be empty.

**Follow-up.** Q: With only one bracket type, can you use less memory? A: Yes, a single counter: increment on '(' and decrement on ')', fail if it goes negative, and require 0 at the end: O(1) space.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(isValid('()[]{}'), true);
assert.equal(isValid('([)]'), false);
assert.equal(isValid('{[]}'), true);
assert.equal(isValid(''), true);
assert.equal(isValid(']'), false);
assert.equal(isValid('(('), false);
```

</details>

</details>

---

<a id="algo-023"></a>
### algo-023. Min Stack

*Stack · Medium*

Design a stack that supports `push(val)`, `pop()`, `top()` and `getMin()` (the minimum element), **each in O(1) time**.

```
const s = new MinStack();
s.push(-2); s.push(0); s.push(-3);
s.getMin(); // -3
s.pop();
s.top();    // 0
s.getMin(); // -2
```

**Starter**

```ts
class MinStack {
  push(val: number): void {}
  pop(): void {}
  top(): number { return 0; }
  getMin(): number { return 0; }
}
```

<details>
<summary>Solution</summary>

```ts
class MinStack {
  private values: number[] = [];
  private mins: number[] = []; // mins[i] = minimum of values[0..i]

  push(val: number): void {
    this.values.push(val);
    const currentMin = this.mins.length ? this.mins[this.mins.length - 1] : val;
    this.mins.push(Math.min(val, currentMin));
  }

  pop(): void {
    this.values.pop();
    this.mins.pop();
  }

  top(): number {
    return this.values[this.values.length - 1];
  }

  getMin(): number {
    return this.mins[this.mins.length - 1];
  }
}
```

**Why it works.** Scanning the stack for the min is O(n) per call, and a single "current min" variable breaks after popping the min. Keep a second stack in parallel where each entry stores the minimum of the stack up to that point; push and pop both stacks together, so the top of the min stack is always the answer. All operations O(1) time, O(n) space.

**Say it.** Alongside the values I keep a parallel stack of running minimums, so whenever I pop, the previous minimum is right there and every operation is O(1).

**Follow-up.** Q: Can you save memory? A: Only push onto the min stack when val <= current min, and pop from it only when the popped value equals its top; or store (value - min) diffs in a single stack.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const ms = new MinStack();
ms.push(-2); ms.push(0); ms.push(-3);
assert.equal(ms.getMin(), -3);
ms.pop();
assert.equal(ms.top(), 0);
assert.equal(ms.getMin(), -2);
const dup = new MinStack();
dup.push(1); dup.push(1); dup.pop();
assert.equal(dup.getMin(), 1);
dup.push(5);
assert.equal(dup.getMin(), 1);
```

</details>

</details>

---

<a id="algo-024"></a>
### algo-024. Evaluate Reverse Polish Notation

*Stack · Medium*

Evaluate an arithmetic expression in Reverse Polish Notation, given as an array of tokens. Operators are `+ - * /`; division **truncates toward zero**. The input is always valid.

```
evalRPN(["2","1","+","3","*"])  -> 9      // (2 + 1) * 3
evalRPN(["4","13","5","/","+"]) -> 6      // 4 + 13 / 5
```

**Starter**

```ts
function evalRPN(tokens: string[]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function evalRPN(tokens: string[]): number {
  const stack: number[] = [];
  for (const token of tokens) {
    if (token === '+' || token === '-' || token === '*' || token === '/') {
      const b = stack.pop()!; // right operand is on top
      const a = stack.pop()!;
      if (token === '+') stack.push(a + b);
      else if (token === '-') stack.push(a - b);
      else if (token === '*') stack.push(a * b);
      else stack.push(Math.trunc(a / b));
    } else {
      stack.push(Number(token));
    }
  }
  return stack[0];
}
```

**Why it works.** RPN is designed for a stack: push numbers, and on an operator pop two operands, apply it, and push the result. The final stack holds the answer. O(n) time, O(n) space. Traps: the first pop is the right operand (matters for - and /), and division must use Math.trunc, not Math.floor, so -7/2 gives -3. Also detect operators explicitly, because "-3" is a number token.

**Say it.** I push numbers onto a stack and, for each operator, pop the right then left operand, compute, and push the result back; the last value is the answer.

**Follow-up.** Q: How would you evaluate a normal infix string like "3 + 4 * 2"? A: Convert to RPN with Dijkstra's shunting-yard algorithm (operator stack with precedence), or evaluate directly with two stacks.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(evalRPN(['2', '1', '+', '3', '*']), 9);
assert.equal(evalRPN(['4', '13', '5', '/', '+']), 6);
assert.equal(evalRPN(['10', '6', '9', '3', '+', '-11', '*', '/', '*', '17', '+', '5', '+']), 22);
assert.equal(evalRPN(['-7', '2', '/']), -3);
assert.equal(evalRPN(['42']), 42);
```

</details>

</details>

---

<a id="algo-025"></a>
### algo-025. Daily Temperatures

*Monotonic stack · Medium*

Given daily `temperatures`, return an array `answer` where `answer[i]` is the number of days you must wait after day `i` for a **warmer** temperature, or `0` if there is none.

```
dailyTemperatures([73,74,75,71,69,72,76,73]) -> [1,1,4,2,1,1,0,0]
dailyTemperatures([30,60,90])                -> [1,1,0]
```

**Starter**

```ts
function dailyTemperatures(temperatures: number[]): number[] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
function dailyTemperatures(temperatures: number[]): number[] {
  const answer = new Array<number>(temperatures.length).fill(0);
  const stack: number[] = []; // indices of days still waiting, temps decreasing
  for (let i = 0; i < temperatures.length; i++) {
    while (stack.length && temperatures[stack[stack.length - 1]] < temperatures[i]) {
      const j = stack.pop()!;
      answer[j] = i - j;
    }
    stack.push(i);
  }
  return answer;
}
```

**Why it works.** Brute force looks ahead from every day, O(n^2). A monotonic decreasing stack holds indices of days that have not yet found a warmer day. When today is warmer than the day on top, that day's answer is resolved (i - j), so pop it and repeat. Each index is pushed and popped once: O(n) time, O(n) space. This "next greater element" template appears in many problems.

**Say it.** I keep a stack of days still waiting for a warmer day; each new temperature pops and resolves all cooler days on top, so every day is pushed and popped once.

**Follow-up.** Q: How would you find the next greater element in a circular array? A: Loop i from 0 to 2n - 1 using i % n, and only push indices during the first pass.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(dailyTemperatures([73, 74, 75, 71, 69, 72, 76, 73]), [1, 1, 4, 2, 1, 1, 0, 0]);
assert.deepEqual(dailyTemperatures([30, 60, 90]), [1, 1, 0]);
assert.deepEqual(dailyTemperatures([90, 80, 70]), [0, 0, 0]);
assert.deepEqual(dailyTemperatures([50, 50, 51]), [2, 1, 0]);
assert.deepEqual(dailyTemperatures([]), []);
```

</details>

</details>

---

<a id="algo-026"></a>
### algo-026. Largest Rectangle in Histogram

*Monotonic stack · Hard*

Given an array `heights` of bar heights in a histogram (each bar width 1), return the area of the largest rectangle that fits inside the histogram.

```
largestRectangleArea([2, 1, 5, 6, 2, 3]) -> 10   // bars 5 and 6, height 5, width 2
largestRectangleArea([2, 4])             -> 4
```

**Starter**

```ts
function largestRectangleArea(heights: number[]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function largestRectangleArea(heights: number[]): number {
  const stack: number[] = []; // indices with increasing heights
  let best = 0;
  for (let i = 0; i <= heights.length; i++) {
    const h = i === heights.length ? 0 : heights[i]; // sentinel 0 flushes the stack
    while (stack.length && heights[stack[stack.length - 1]] >= h) {
      const height = heights[stack.pop()!];
      // Bar extends right up to i - 1 and left to just after the new stack top
      const leftBound = stack.length ? stack[stack.length - 1] : -1;
      best = Math.max(best, height * (i - leftBound - 1));
    }
    stack.push(i);
  }
  return best;
}
```

**Why it works.** Brute force tries every pair (or expands from each bar), O(n^2). For each bar, the widest rectangle using its full height stretches to the nearest shorter bar on each side. A monotonic increasing stack finds both: when a shorter bar arrives at i, the popped bar's right limit is i and its left limit is the new stack top. A sentinel height 0 at the end flushes remaining bars. O(n) time, O(n) space.

**Say it.** For each bar I need the nearest shorter bar on both sides; an increasing stack gives that when a bar is popped, so I compute height times width at pop time in O(n).

**Follow-up.** Q: How does this help with Maximal Rectangle in a binary matrix? A: Build a histogram per row (heights of consecutive 1s above each cell) and run this algorithm on every row: O(rows * cols).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(largestRectangleArea([2, 1, 5, 6, 2, 3]), 10);
assert.equal(largestRectangleArea([2, 4]), 4);
assert.equal(largestRectangleArea([]), 0);
assert.equal(largestRectangleArea([3, 3, 3]), 9);
assert.equal(largestRectangleArea([6, 2, 5, 4, 5, 1, 6]), 12);
```

</details>

</details>

---

<a id="algo-027"></a>
### algo-027. Binary Search

*Binary search · Easy*

Given a sorted array of distinct integers `nums` and a `target`, return the index of `target`, or `-1` if it is absent. Must run in O(log n).

```
search([-1, 0, 3, 5, 9, 12], 9) -> 4
search([-1, 0, 3, 5, 9, 12], 2) -> -1
```

**Starter**

```ts
function search(nums: number[], target: number): number {
  // TODO
  return -1;
}
```

<details>
<summary>Solution</summary>

```ts
function search(nums: number[], target: number): number {
  let lo = 0;
  let hi = nums.length - 1;
  while (lo <= hi) {
    const mid = lo + ((hi - lo) >> 1);
    if (nums[mid] === target) return mid;
    if (nums[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
```

**Why it works.** A linear scan is O(n). Binary search keeps an inclusive range [lo, hi] that must contain the target if it exists, and halves it each step by comparing with the middle element. O(log n) time, O(1) space. Traps: use `lo <= hi` with an inclusive hi, always move past mid (mid + 1 / mid - 1) to avoid infinite loops, and compute mid as lo + (hi - lo) / 2 to avoid overflow in fixed-width languages.

**Say it.** I keep an inclusive range and compare the middle element with the target, discarding the half that cannot contain it, so it is O(log n).

**Follow-up.** Q: How do you find the insert position if the target is missing? A: Return lo after the loop: it ends as the first index whose value is greater than the target (lower bound).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(search([-1, 0, 3, 5, 9, 12], 9), 4);
assert.equal(search([-1, 0, 3, 5, 9, 12], 2), -1);
assert.equal(search([], 1), -1);
assert.equal(search([5], 5), 0);
assert.equal(search([1, 2, 3, 4, 5, 6], 1), 0);
assert.equal(search([1, 2, 3, 4, 5, 6], 6), 5);
```

</details>

</details>

---

<a id="algo-028"></a>
### algo-028. Search a 2D Matrix

*Binary search · Medium*

You are given an `m x n` matrix where each row is sorted and the first value of each row is greater than the last value of the previous row. Return `true` if `target` is in the matrix, in O(log(m * n)).

```
searchMatrix([[1,3,5,7],[10,11,16,20],[23,30,34,60]], 3)  -> true
searchMatrix([[1,3,5,7],[10,11,16,20],[23,30,34,60]], 13) -> false
```

**Starter**

```ts
function searchMatrix(matrix: number[][], target: number): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
function searchMatrix(matrix: number[][], target: number): boolean {
  if (matrix.length === 0 || matrix[0].length === 0) return false;
  const cols = matrix[0].length;
  let lo = 0;
  let hi = matrix.length * cols - 1;
  while (lo <= hi) {
    const mid = lo + ((hi - lo) >> 1);
    // Treat the matrix as one flattened sorted array
    const value = matrix[Math.floor(mid / cols)][mid % cols];
    if (value === target) return true;
    if (value < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}
```

**Why it works.** Scanning every cell is O(m * n); binary searching each row is O(m log n). Because rows chain together in sorted order, the matrix is really one sorted array of length m * n: binary search over virtual indices and map index i to row i / cols and column i % cols. O(log(m * n)) time, O(1) space.

**Say it.** The rows chain into one sorted list, so I binary search over indices 0 to m*n-1 and convert each index to a row and column with division and modulo.

**Follow-up.** Q: What if only rows and columns are sorted independently (Search a 2D Matrix II)? A: Start at the top-right corner: move left if the value is too big, down if too small: O(m + n).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const m = [[1, 3, 5, 7], [10, 11, 16, 20], [23, 30, 34, 60]];
assert.equal(searchMatrix(m, 3), true);
assert.equal(searchMatrix(m, 13), false);
assert.equal(searchMatrix(m, 60), true);
assert.equal(searchMatrix(m, 1), true);
assert.equal(searchMatrix([[1]], 2), false);
assert.equal(searchMatrix([], 1), false);
```

</details>

</details>

---

<a id="algo-029"></a>
### algo-029. Koko Eating Bananas

*Binary search on answer · Medium*

Koko has `piles` of bananas and `h` hours. Each hour she picks one pile and eats up to `k` bananas from it (if fewer remain, she finishes the pile and waits out the hour). Return the minimum integer speed `k` that lets her eat everything within `h` hours.

```
minEatingSpeed([3, 6, 7, 11], 8)       -> 4
minEatingSpeed([30, 11, 23, 4, 20], 5) -> 30
```

**Starter**

```ts
function minEatingSpeed(piles: number[], h: number): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function minEatingSpeed(piles: number[], h: number): number {
  const hoursNeeded = (k: number) => piles.reduce((sum, p) => sum + Math.ceil(p / k), 0);
  let lo = 1;
  let hi = Math.max(...piles);
  // Find the smallest k with hoursNeeded(k) <= h
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    if (hoursNeeded(mid) <= h) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
```

**Why it works.** Trying every speed from 1 to max(piles) costs O(n * max). The key insight is monotonicity: if speed k works, every faster speed also works. So binary search the answer space [1, max(piles)] for the first speed that fits, with each check costing O(n). O(n log m) time where m = max pile, O(1) space. Use the `lo < hi`, `hi = mid` form for "first true" searches.

**Say it.** Feasibility is monotonic in the speed, so I binary search over speeds from 1 to the largest pile, checking in O(n) whether a speed finishes in h hours, and keep the smallest that works.

**Follow-up.** Q: Where else does "binary search on the answer" apply? A: Capacity to Ship Packages Within D Days, Split Array Largest Sum, minimum days to make bouquets: any problem with a monotonic yes/no check over a numeric range.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(minEatingSpeed([3, 6, 7, 11], 8), 4);
assert.equal(minEatingSpeed([30, 11, 23, 4, 20], 5), 30);
assert.equal(minEatingSpeed([30, 11, 23, 4, 20], 6), 23);
assert.equal(minEatingSpeed([1], 1), 1);
assert.equal(minEatingSpeed([1000000000], 2), 500000000);
```

</details>

</details>

---

<a id="algo-030"></a>
### algo-030. Find Minimum in Rotated Sorted Array

*Binary search · Medium*

A sorted array of **unique** integers was rotated an unknown number of times (e.g. `[0,1,2,4,5,6,7]` -> `[4,5,6,7,0,1,2]`). Return its minimum element in O(log n).

```
findMin([3, 4, 5, 1, 2])       -> 1
findMin([4, 5, 6, 7, 0, 1, 2]) -> 0
findMin([11, 13, 15, 17])      -> 11
```

**Starter**

```ts
function findMin(nums: number[]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function findMin(nums: number[]): number {
  let lo = 0;
  let hi = nums.length - 1;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    // If mid is bigger than the right end, the drop (minimum) is to the right of mid
    if (nums[mid] > nums[hi]) lo = mid + 1;
    else hi = mid;
  }
  return nums[lo];
}
```

**Why it works.** A linear scan is O(n). Compare the middle element with the right end: if nums[mid] > nums[hi], the rotation point (the minimum) lies strictly right of mid; otherwise mid..hi is sorted and the minimum is at mid or to its left. Shrink until lo === hi. O(log n) time, O(1) space. Trap: comparing with nums[lo] instead of nums[hi] fails on an unrotated array.

**Say it.** I compare the middle with the rightmost element: if the middle is larger, the drop is to the right, otherwise the minimum is at mid or to its left, halving the range each time.

**Follow-up.** Q: What if duplicates are allowed? A: When nums[mid] === nums[hi] you cannot tell which side to drop, so just do hi--; worst case becomes O(n).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(findMin([3, 4, 5, 1, 2]), 1);
assert.equal(findMin([4, 5, 6, 7, 0, 1, 2]), 0);
assert.equal(findMin([11, 13, 15, 17]), 11);
assert.equal(findMin([2, 1]), 1);
assert.equal(findMin([5]), 5);
```

</details>

</details>

---

<a id="algo-031"></a>
### algo-031. Search in Rotated Sorted Array

*Binary search · Medium*

A sorted array of **distinct** integers was rotated at an unknown pivot. Given `nums` and `target`, return the index of `target` or `-1`, in O(log n).

```
searchRotated([4,5,6,7,0,1,2], 0) -> 4
searchRotated([4,5,6,7,0,1,2], 3) -> -1
searchRotated([1], 0)             -> -1
```

**Starter**

```ts
function searchRotated(nums: number[], target: number): number {
  // TODO
  return -1;
}
```

<details>
<summary>Solution</summary>

```ts
function searchRotated(nums: number[], target: number): number {
  let lo = 0;
  let hi = nums.length - 1;
  while (lo <= hi) {
    const mid = lo + ((hi - lo) >> 1);
    if (nums[mid] === target) return mid;
    if (nums[lo] <= nums[mid]) {
      // Left half [lo..mid] is sorted
      if (nums[lo] <= target && target < nums[mid]) hi = mid - 1;
      else lo = mid + 1;
    } else {
      // Right half [mid..hi] is sorted
      if (nums[mid] < target && target <= nums[hi]) lo = mid + 1;
      else hi = mid - 1;
    }
  }
  return -1;
}
```

**Why it works.** A linear scan is O(n). In a rotated array, at least one half around mid is always fully sorted; determine which (compare nums[lo] with nums[mid]), check whether the target lies within that sorted half's range, and discard the other half accordingly. O(log n) time, O(1) space. Trap: use `<=` in nums[lo] <= nums[mid] so the case lo === mid counts as a sorted left half.

**Say it.** At every step one half is sorted; I check whether the target falls inside that sorted half's range and keep it, otherwise I search the other half.

**Follow-up.** Q: Alternative approach? A: First find the rotation index with the find-minimum binary search, then run a normal binary search on the correct sorted part. Still O(log n).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(searchRotated([4, 5, 6, 7, 0, 1, 2], 0), 4);
assert.equal(searchRotated([4, 5, 6, 7, 0, 1, 2], 3), -1);
assert.equal(searchRotated([1], 0), -1);
assert.equal(searchRotated([3, 1], 1), 1);
assert.equal(searchRotated([5, 1, 3], 5), 0);
assert.equal(searchRotated([1, 2, 3, 4], 4), 3);
```

</details>

</details>

---

<a id="algo-032"></a>
### algo-032. Find First and Last Position of Element

*Binary search · Medium*

Given a sorted array `nums` (may contain duplicates) and a `target`, return `[first, last]`, the first and last index of `target`, or `[-1, -1]` if absent. Must be O(log n).

```
searchRange([5, 7, 7, 8, 8, 10], 8) -> [3, 4]
searchRange([5, 7, 7, 8, 8, 10], 6) -> [-1, -1]
```

**Starter**

```ts
function searchRange(nums: number[], target: number): [number, number] {
  // TODO
  return [-1, -1];
}
```

<details>
<summary>Solution</summary>

```ts
// First index i with nums[i] >= target (nums.length if none)
function lowerBound(nums: number[], target: number): number {
  let lo = 0;
  let hi = nums.length;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    if (nums[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function searchRange(nums: number[], target: number): [number, number] {
  const first = lowerBound(nums, target);
  if (first === nums.length || nums[first] !== target) return [-1, -1];
  const last = lowerBound(nums, target + 1) - 1;
  return [first, last];
}
```

**Why it works.** Finding any match with binary search and then scanning outward is O(n) in the worst case (all equal). Instead run two boundary searches: lower bound of target gives the first index, and lower bound of target + 1 minus one gives the last. A half-open range [lo, hi) with `hi = mid` keeps searching left after a match. O(log n) time, O(1) space. (For non-integers, write a separate upper-bound search with `<=`.)

**Say it.** I write a lower-bound binary search and call it twice: once for the target to get the first index, and once for target + 1 to get one past the last.

**Follow-up.** Q: How do you count occurrences of target in a sorted array? A: upperBound - lowerBound, i.e. last - first + 1 from this function, in O(log n).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(searchRange([5, 7, 7, 8, 8, 10], 8), [3, 4]);
assert.deepEqual(searchRange([5, 7, 7, 8, 8, 10], 6), [-1, -1]);
assert.deepEqual(searchRange([], 0), [-1, -1]);
assert.deepEqual(searchRange([2, 2, 2, 2], 2), [0, 3]);
assert.deepEqual(searchRange([1, 3], 1), [0, 0]);
assert.deepEqual(searchRange([1, 3], 4), [-1, -1]);
```

</details>

</details>

---

<a id="algo-033"></a>
### algo-033. Reverse Linked List

*Linked list · Easy*

Given the `head` of a singly linked list, reverse the list and return the new head.

```
1 -> 2 -> 3 -> 4 -> 5   =>   5 -> 4 -> 3 -> 2 -> 1
[] -> []
```

**Starter**

```ts
class ListNode {
  val: number;
  next: ListNode | null;
  constructor(val = 0, next: ListNode | null = null) {
    this.val = val;
    this.next = next;
  }
}

function reverseList(head: ListNode | null): ListNode | null {
  // TODO
  return null;
}
```

<details>
<summary>Solution</summary>

```ts
class ListNode {
  val: number;
  next: ListNode | null;
  constructor(val = 0, next: ListNode | null = null) {
    this.val = val;
    this.next = next;
  }
}

function fromArray(values: number[]): ListNode | null {
  let head: ListNode | null = null;
  for (let i = values.length - 1; i >= 0; i--) head = new ListNode(values[i], head);
  return head;
}

function toArray(head: ListNode | null): number[] {
  const out: number[] = [];
  for (let node = head; node; node = node.next) out.push(node.val);
  return out;
}

function reverseList(head: ListNode | null): ListNode | null {
  let prev: ListNode | null = null;
  let curr = head;
  while (curr) {
    const next = curr.next; // save before overwriting
    curr.next = prev;
    prev = curr;
    curr = next;
  }
  return prev;
}
```

**Why it works.** Copying values into an array and rebuilding uses O(n) extra space. Iteratively, walk the list with `prev` and `curr`, saving `curr.next` before pointing `curr.next` back at `prev`; when `curr` is null, `prev` is the new head. O(n) time, O(1) space. A recursive version is also O(n) time but uses O(n) call stack. Trap: losing the rest of the list by not saving next first.

**Say it.** I walk the list once with prev and curr pointers, flipping each next pointer backwards after saving the original next, and return prev as the new head.

**Follow-up.** Q: Can you do it recursively? A: Reverse the rest (newHead = reverseList(head.next)), then set head.next.next = head and head.next = null; return newHead. O(n) stack space.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(toArray(reverseList(fromArray([1, 2, 3, 4, 5]))), [5, 4, 3, 2, 1]);
assert.deepEqual(toArray(reverseList(fromArray([1, 2]))), [2, 1]);
assert.deepEqual(toArray(reverseList(fromArray([7]))), [7]);
assert.equal(reverseList(null), null);
```

</details>

</details>

---

<a id="algo-034"></a>
### algo-034. Merge Two Sorted Lists

*Linked list · Easy*

Merge two sorted linked lists `list1` and `list2` into one sorted list by splicing their nodes together. Return the head of the merged list.

```
[1,2,4] + [1,3,4] -> [1,1,2,3,4,4]
[] + [0]          -> [0]
```

**Starter**

```ts
class ListNode {
  val: number;
  next: ListNode | null;
  constructor(val = 0, next: ListNode | null = null) {
    this.val = val;
    this.next = next;
  }
}

function mergeTwoLists(list1: ListNode | null, list2: ListNode | null): ListNode | null {
  // TODO
  return null;
}
```

<details>
<summary>Solution</summary>

```ts
class ListNode {
  val: number;
  next: ListNode | null;
  constructor(val = 0, next: ListNode | null = null) {
    this.val = val;
    this.next = next;
  }
}

function fromArray(values: number[]): ListNode | null {
  let head: ListNode | null = null;
  for (let i = values.length - 1; i >= 0; i--) head = new ListNode(values[i], head);
  return head;
}

function toArray(head: ListNode | null): number[] {
  const out: number[] = [];
  for (let node = head; node; node = node.next) out.push(node.val);
  return out;
}

function mergeTwoLists(list1: ListNode | null, list2: ListNode | null): ListNode | null {
  const dummy = new ListNode(); // avoids special-casing the head
  let tail = dummy;
  let a = list1;
  let b = list2;
  while (a && b) {
    if (a.val <= b.val) {
      tail.next = a;
      a = a.next;
    } else {
      tail.next = b;
      b = b.next;
    }
    tail = tail.next;
  }
  tail.next = a ?? b; // attach whatever remains
  return dummy.next;
}
```

**Why it works.** Collecting all values, sorting, and rebuilding costs O((n + m) log(n + m)) and extra space. Since both lists are already sorted, repeatedly take the smaller head and append it to a tail pointer, then attach the leftover list in one step. A dummy head node removes the "which node is the head?" special case. O(n + m) time, O(1) extra space.

**Say it.** I use a dummy head and a tail pointer, always splicing in the smaller of the two current nodes, and attach whatever is left at the end.

**Follow-up.** Q: How do you merge k sorted lists? A: Use a min-heap of the k current heads (O(N log k)), or merge pairs in rounds like merge sort (also O(N log k)).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(toArray(mergeTwoLists(fromArray([1, 2, 4]), fromArray([1, 3, 4]))), [1, 1, 2, 3, 4, 4]);
assert.deepEqual(toArray(mergeTwoLists(null, fromArray([0]))), [0]);
assert.equal(mergeTwoLists(null, null), null);
assert.deepEqual(toArray(mergeTwoLists(fromArray([5, 6]), fromArray([1, 2, 3]))), [1, 2, 3, 5, 6]);
```

</details>

</details>

---

<a id="algo-035"></a>
### algo-035. Linked List Cycle

*Fast & slow pointers · Easy*

Given the `head` of a linked list, return `true` if the list contains a cycle (some node's `next` points back to an earlier node). Use O(1) memory.

```
3 -> 2 -> 0 -> -4 -> (back to 2)  -> true
1 -> 2 -> null                     -> false
```

**Starter**

```ts
class ListNode {
  val: number;
  next: ListNode | null;
  constructor(val = 0, next: ListNode | null = null) {
    this.val = val;
    this.next = next;
  }
}

function hasCycle(head: ListNode | null): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
class ListNode {
  val: number;
  next: ListNode | null;
  constructor(val = 0, next: ListNode | null = null) {
    this.val = val;
    this.next = next;
  }
}

function fromArray(values: number[]): ListNode | null {
  let head: ListNode | null = null;
  for (let i = values.length - 1; i >= 0; i--) head = new ListNode(values[i], head);
  return head;
}

function toArray(head: ListNode | null): number[] {
  const out: number[] = [];
  for (let node = head; node; node = node.next) out.push(node.val);
  return out;
}

function hasCycle(head: ListNode | null): boolean {
  let slow = head;
  let fast = head;
  while (fast && fast.next) {
    slow = slow!.next;
    fast = fast.next.next;
    if (slow === fast) return true;
  }
  return false;
}
```

**Why it works.** Storing visited nodes in a Set detects a cycle in O(n) time but O(n) space. Floyd's tortoise and hare moves `slow` one step and `fast` two steps: if there is no cycle, fast hits null; if there is, fast gains one node per step on slow inside the loop and must meet it. O(n) time, O(1) space. Compare node identity, not values.

**Say it.** I use Floyd's algorithm: a slow pointer moves one step and a fast pointer two; if they ever meet there is a cycle, and if fast reaches null there is not.

**Follow-up.** Q: How do you find where the cycle starts? A: After they meet, reset one pointer to head and move both one step at a time; the node where they meet again is the cycle start.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const withCycle = fromArray([3, 2, 0, -4])!;
withCycle.next!.next!.next!.next = withCycle.next; // -4 -> 2
assert.equal(hasCycle(withCycle), true);
assert.equal(hasCycle(fromArray([1, 2])), false);
assert.equal(hasCycle(null), false);
const self = new ListNode(1);
self.next = self;
assert.equal(hasCycle(self), true);
```

</details>

</details>

---

<a id="algo-036"></a>
### algo-036. Remove Nth Node From End of List

*Two pointers (gap) · Medium*

Given the `head` of a linked list, remove the `n`-th node **from the end** and return the head. Do it in one pass. `n` is always valid.

```
[1,2,3,4,5], n = 2 -> [1,2,3,5]
[1], n = 1         -> []
[1,2], n = 1       -> [1]
```

**Starter**

```ts
class ListNode {
  val: number;
  next: ListNode | null;
  constructor(val = 0, next: ListNode | null = null) {
    this.val = val;
    this.next = next;
  }
}

function removeNthFromEnd(head: ListNode | null, n: number): ListNode | null {
  // TODO
  return head;
}
```

<details>
<summary>Solution</summary>

```ts
class ListNode {
  val: number;
  next: ListNode | null;
  constructor(val = 0, next: ListNode | null = null) {
    this.val = val;
    this.next = next;
  }
}

function fromArray(values: number[]): ListNode | null {
  let head: ListNode | null = null;
  for (let i = values.length - 1; i >= 0; i--) head = new ListNode(values[i], head);
  return head;
}

function toArray(head: ListNode | null): number[] {
  const out: number[] = [];
  for (let node = head; node; node = node.next) out.push(node.val);
  return out;
}

function removeNthFromEnd(head: ListNode | null, n: number): ListNode | null {
  const dummy = new ListNode(0, head); // handles removing the head itself
  let fast: ListNode | null = dummy;
  let slow: ListNode = dummy;
  for (let i = 0; i <= n; i++) fast = fast!.next; // gap of n nodes between slow and fast
  while (fast) {
    fast = fast.next;
    slow = slow.next!;
  }
  slow.next = slow.next!.next; // slow is just before the node to remove
  return dummy.next;
}
```

**Why it works.** The two-pass approach counts the length L, then walks to node L - n. For one pass, advance `fast` n + 1 steps from a dummy node, then move both pointers until fast is null; slow is now right before the target, so unlink it. The dummy node handles removing the head. O(L) time, O(1) space.

**Say it.** I put a gap of n nodes between two pointers starting at a dummy head, move them together until the fast one falls off, and then the slow one sits just before the node to delete.

**Follow-up.** Q: Why the dummy node? A: When n equals the list length, the head must be removed; with a dummy, slow stays at the dummy and dummy.next is updated, so no special case is needed.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(toArray(removeNthFromEnd(fromArray([1, 2, 3, 4, 5]), 2)), [1, 2, 3, 5]);
assert.deepEqual(toArray(removeNthFromEnd(fromArray([1]), 1)), []);
assert.deepEqual(toArray(removeNthFromEnd(fromArray([1, 2]), 1)), [1]);
assert.deepEqual(toArray(removeNthFromEnd(fromArray([1, 2]), 2)), [2]);
```

</details>

</details>

---

<a id="algo-037"></a>
### algo-037. Reorder List

*Linked list · Medium*

Given a list `L0 -> L1 -> ... -> Ln-1 -> Ln`, reorder it **in place** to `L0 -> Ln -> L1 -> Ln-1 -> L2 -> Ln-2 -> ...`. Do not change node values, only links.

```
[1,2,3,4]   -> [1,4,2,3]
[1,2,3,4,5] -> [1,5,2,4,3]
```

**Starter**

```ts
class ListNode {
  val: number;
  next: ListNode | null;
  constructor(val = 0, next: ListNode | null = null) {
    this.val = val;
    this.next = next;
  }
}

function reorderList(head: ListNode | null): void {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
class ListNode {
  val: number;
  next: ListNode | null;
  constructor(val = 0, next: ListNode | null = null) {
    this.val = val;
    this.next = next;
  }
}

function fromArray(values: number[]): ListNode | null {
  let head: ListNode | null = null;
  for (let i = values.length - 1; i >= 0; i--) head = new ListNode(values[i], head);
  return head;
}

function toArray(head: ListNode | null): number[] {
  const out: number[] = [];
  for (let node = head; node; node = node.next) out.push(node.val);
  return out;
}

function reorderList(head: ListNode | null): void {
  if (!head || !head.next) return;

  // 1. Find the middle (slow ends at the end of the first half)
  let slow: ListNode = head;
  let fast: ListNode | null = head;
  while (fast.next && fast.next.next) {
    slow = slow.next!;
    fast = fast.next.next;
  }

  // 2. Reverse the second half
  let prev: ListNode | null = null;
  let curr: ListNode | null = slow.next;
  slow.next = null;
  while (curr) {
    const next: ListNode | null = curr.next;
    curr.next = prev;
    prev = curr;
    curr = next;
  }

  // 3. Interleave the two halves
  let first: ListNode | null = head;
  let second: ListNode | null = prev;
  while (second) {
    const firstNext: ListNode | null = first!.next;
    const secondNext: ListNode | null = second.next;
    first!.next = second;
    second.next = firstNext;
    first = firstNext;
    second = secondNext;
  }
}
```

**Why it works.** Pushing nodes into an array and relinking from both ends is simple but uses O(n) space. The O(1)-space approach combines three classic steps: find the middle with slow/fast pointers, reverse the second half, then merge the halves alternately. O(n) time, O(1) space. Trap: cut the first half (slow.next = null) or you create a cycle.

**Say it.** I split the list at the middle with fast and slow pointers, reverse the second half, and then weave the two halves together node by node.

**Follow-up.** Q: How would you check if a linked list is a palindrome in O(1) space? A: Same first two steps: find the middle, reverse the second half, then compare the halves node by node (optionally restore the list).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const run = (a: number[]) => { const h = fromArray(a); reorderList(h); return toArray(h); };
assert.deepEqual(run([1, 2, 3, 4]), [1, 4, 2, 3]);
assert.deepEqual(run([1, 2, 3, 4, 5]), [1, 5, 2, 4, 3]);
assert.deepEqual(run([1]), [1]);
assert.deepEqual(run([1, 2]), [1, 2]);
assert.deepEqual(run([]), []);
```

</details>

</details>

---

<a id="algo-038"></a>
### algo-038. Add Two Numbers

*Linked list · Medium*

Two non-negative integers are stored as linked lists in **reverse order**, one digit per node. Add them and return the sum as a linked list in the same format.

```
[2,4,3] + [5,6,4] -> [7,0,8]        // 342 + 465 = 807
[9,9,9,9] + [9,9] -> [8,9,0,0,1]    // 9999 + 99 = 10098
```

**Starter**

```ts
class ListNode {
  val: number;
  next: ListNode | null;
  constructor(val = 0, next: ListNode | null = null) {
    this.val = val;
    this.next = next;
  }
}

function addTwoNumbers(l1: ListNode | null, l2: ListNode | null): ListNode | null {
  // TODO
  return null;
}
```

<details>
<summary>Solution</summary>

```ts
class ListNode {
  val: number;
  next: ListNode | null;
  constructor(val = 0, next: ListNode | null = null) {
    this.val = val;
    this.next = next;
  }
}

function fromArray(values: number[]): ListNode | null {
  let head: ListNode | null = null;
  for (let i = values.length - 1; i >= 0; i--) head = new ListNode(values[i], head);
  return head;
}

function toArray(head: ListNode | null): number[] {
  const out: number[] = [];
  for (let node = head; node; node = node.next) out.push(node.val);
  return out;
}

function addTwoNumbers(l1: ListNode | null, l2: ListNode | null): ListNode | null {
  const dummy = new ListNode();
  let tail = dummy;
  let carry = 0;
  while (l1 || l2 || carry) {
    const sum = (l1?.val ?? 0) + (l2?.val ?? 0) + carry;
    carry = Math.floor(sum / 10);
    tail.next = new ListNode(sum % 10);
    tail = tail.next;
    l1 = l1?.next ?? null;
    l2 = l2?.next ?? null;
  }
  return dummy.next;
}
```

**Why it works.** Converting the lists to numbers, adding, and converting back overflows for long inputs (beyond 2^53 in JS; BigInt only hides the problem). Instead simulate grade-school addition: the lists are least-significant digit first, so walk both together, add digits plus carry, emit sum % 10, and carry the rest. Keep looping while either list or the carry remains. O(max(n, m)) time, O(max(n, m)) space for the result.

**Say it.** I add digit by digit like on paper, walking both lists together with a carry, and keep going until both lists and the carry are exhausted.

**Follow-up.** Q: What if the digits are stored in forward order? A: Reverse both lists first, or push digits onto two stacks and pop them to add from the least significant end, prepending result nodes.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(toArray(addTwoNumbers(fromArray([2, 4, 3]), fromArray([5, 6, 4]))), [7, 0, 8]);
assert.deepEqual(toArray(addTwoNumbers(fromArray([0]), fromArray([0]))), [0]);
assert.deepEqual(toArray(addTwoNumbers(fromArray([9, 9, 9, 9]), fromArray([9, 9]))), [8, 9, 0, 0, 1]);
assert.deepEqual(toArray(addTwoNumbers(fromArray([5]), fromArray([5]))), [0, 1]);
```

</details>

</details>

---

<a id="algo-039"></a>
### algo-039. Merge Intervals

*Intervals · Medium*

Given an array of `intervals` where `intervals[i] = [start, end]`, merge all overlapping intervals and return the non-overlapping intervals that cover all the input. Intervals that touch (`[1,4]` and `[4,5]`) count as overlapping.

```
merge([[1,3],[2,6],[8,10],[15,18]]) -> [[1,6],[8,10],[15,18]]
merge([[1,4],[4,5]])               -> [[1,5]]
```

**Starter**

```ts
function merge(intervals: number[][]): number[][] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
function merge(intervals: number[][]): number[][] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const result: number[][] = [];
  for (const [start, end] of sorted) {
    const last = result[result.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end); // overlap: extend
    } else {
      result.push([start, end]);
    }
  }
  return result;
}
```

**Why it works.** Comparing every pair repeatedly until nothing merges is O(n^2) or worse. Sort by start time; then any interval that overlaps the current merged block must come right after it, so a single pass either extends the last block or starts a new one. O(n log n) time for the sort, O(n) space for the output. Traps: extend with Math.max (the new interval may be fully contained) and copy intervals so the input is not mutated.

**Say it.** I sort by start, then walk the intervals and either extend the last merged interval when they overlap or start a new one, which is O(n log n) for the sort.

**Follow-up.** Q: What if intervals arrive as a stream? A: Keep them in a balanced BST / sorted structure keyed by start, and on each insert merge with the neighbours (O(log n) per insert plus merges).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(merge([[1, 3], [2, 6], [8, 10], [15, 18]]), [[1, 6], [8, 10], [15, 18]]);
assert.deepEqual(merge([[1, 4], [4, 5]]), [[1, 5]]);
assert.deepEqual(merge([[1, 4], [2, 3]]), [[1, 4]]);
assert.deepEqual(merge([[5, 6], [1, 2]]), [[1, 2], [5, 6]]);
assert.deepEqual(merge([]), []);
```

</details>

</details>

---

<a id="algo-040"></a>
### algo-040. Insert Interval

*Intervals · Medium*

You are given non-overlapping `intervals` sorted by start, and a `newInterval`. Insert it so the list stays sorted and non-overlapping (merge where needed). Return the result.

```
insert([[1,3],[6,9]], [2,5])                     -> [[1,5],[6,9]]
insert([[1,2],[3,5],[6,7],[8,10],[12,16]], [4,8]) -> [[1,2],[3,10],[12,16]]
```

**Starter**

```ts
function insert(intervals: number[][], newInterval: number[]): number[][] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
function insert(intervals: number[][], newInterval: number[]): number[][] {
  const result: number[][] = [];
  let [start, end] = newInterval;
  let i = 0;
  // 1. Intervals entirely before the new one
  while (i < intervals.length && intervals[i][1] < start) result.push(intervals[i++]);
  // 2. Overlapping intervals: absorb into [start, end]
  while (i < intervals.length && intervals[i][0] <= end) {
    start = Math.min(start, intervals[i][0]);
    end = Math.max(end, intervals[i][1]);
    i++;
  }
  result.push([start, end]);
  // 3. Intervals entirely after
  while (i < intervals.length) result.push(intervals[i++]);
  return result;
}
```

**Why it works.** You could append the new interval and rerun Merge Intervals, but that costs O(n log n) and ignores that the input is already sorted. Instead do one pass in three phases: copy intervals that end before the new one starts, absorb every interval that overlaps (widen start/end), push the merged interval, then copy the rest. O(n) time, O(n) space for the output.

**Say it.** Since the input is sorted, I copy everything that ends before the new interval, merge all overlapping intervals into it, then copy the rest, all in one linear pass.

**Follow-up.** Q: Could you find the insertion range faster? A: Yes, binary search for the first and last overlapping intervals in O(log n), but building the output array is still O(n).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(insert([[1, 3], [6, 9]], [2, 5]), [[1, 5], [6, 9]]);
assert.deepEqual(insert([[1, 2], [3, 5], [6, 7], [8, 10], [12, 16]], [4, 8]), [[1, 2], [3, 10], [12, 16]]);
assert.deepEqual(insert([], [5, 7]), [[5, 7]]);
assert.deepEqual(insert([[1, 5]], [6, 8]), [[1, 5], [6, 8]]);
assert.deepEqual(insert([[3, 5]], [1, 2]), [[1, 2], [3, 5]]);
assert.deepEqual(insert([[1, 5]], [0, 9]), [[0, 9]]);
```

</details>

</details>

---

<a id="algo-041"></a>
### algo-041. Non-overlapping Intervals

*Intervals (greedy) · Medium*

Given an array of `intervals`, return the **minimum number of intervals to remove** so the rest do not overlap. Intervals that only touch (`[1,2]` and `[2,3]`) do not overlap.

```
eraseOverlapIntervals([[1,2],[2,3],[3,4],[1,3]]) -> 1
eraseOverlapIntervals([[1,2],[1,2],[1,2]])       -> 2
eraseOverlapIntervals([[1,2],[2,3]])             -> 0
```

**Starter**

```ts
function eraseOverlapIntervals(intervals: number[][]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function eraseOverlapIntervals(intervals: number[][]): number {
  const sorted = [...intervals].sort((a, b) => a[1] - b[1]); // by end time
  let removed = 0;
  let lastEnd = -Infinity;
  for (const [start, end] of sorted) {
    if (start >= lastEnd) lastEnd = end; // keep it
    else removed++; // overlaps the kept one, which ends earlier
  }
  return removed;
}
```

**Why it works.** Trying all subsets is exponential. This is the activity-selection problem: keep as many intervals as possible, and the greedy choice is to always keep the interval that ends earliest, since it leaves the most room for the rest. Sort by end, keep an interval if it starts at or after the last kept end, otherwise remove it. Answer = n - kept. O(n log n) time, O(n) space for the sorted copy (O(1) if sorting in place).

**Say it.** I sort by end time and greedily keep each interval that starts after the last kept one ends; the earliest end leaves the most room, so the rest must be removed.

**Follow-up.** Q: How is this related to "minimum arrows to burst balloons"? A: Same greedy: sort by end, shoot at the end of the first balloon, and count a new arrow whenever a balloon starts after the current arrow position.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(eraseOverlapIntervals([[1, 2], [2, 3], [3, 4], [1, 3]]), 1);
assert.equal(eraseOverlapIntervals([[1, 2], [1, 2], [1, 2]]), 2);
assert.equal(eraseOverlapIntervals([[1, 2], [2, 3]]), 0);
assert.equal(eraseOverlapIntervals([]), 0);
assert.equal(eraseOverlapIntervals([[1, 100], [11, 22], [1, 11], [2, 12]]), 2);
```

</details>

</details>

---

<a id="algo-042"></a>
### algo-042. Meeting Rooms II

*Intervals (sweep line) · Medium*

Given meeting time `intervals` `[start, end]`, return the **minimum number of conference rooms** required. A meeting ending at time `t` frees its room for one starting at `t`.

```
minMeetingRooms([[0,30],[5,10],[15,20]]) -> 2
minMeetingRooms([[7,10],[2,4]])          -> 1
```

**Starter**

```ts
function minMeetingRooms(intervals: number[][]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function minMeetingRooms(intervals: number[][]): number {
  const starts = intervals.map((i) => i[0]).sort((a, b) => a - b);
  const ends = intervals.map((i) => i[1]).sort((a, b) => a - b);
  let rooms = 0;
  let best = 0;
  let e = 0;
  for (let s = 0; s < starts.length; s++) {
    // Free every room whose meeting has ended by this start time
    while (ends[e] <= starts[s]) {
      rooms--;
      e++;
    }
    rooms++;
    best = Math.max(best, rooms);
  }
  return best;
}
```

**Why it works.** Brute force checks, for every time point, how many meetings are active: O(n^2). The answer is the maximum number of meetings running at once. Sort start times and end times separately and sweep: each start takes a room, and before that you release rooms for every meeting that ended at or before this start. O(n log n) time, O(n) space. Alternative: sort by start and keep a min-heap of end times; the heap size is the answer. Trap: use `<=` so back-to-back meetings share a room.

**Say it.** I sort starts and ends separately and sweep through time: each start needs a room, each end at or before it frees one, and the peak number of rooms in use is the answer.

**Follow-up.** Q: Can you return which room each meeting gets? A: Sort by start and use a min-heap of (endTime, roomId); reuse the room at the top if it is free, otherwise open a new room id.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(minMeetingRooms([[0, 30], [5, 10], [15, 20]]), 2);
assert.equal(minMeetingRooms([[7, 10], [2, 4]]), 1);
assert.equal(minMeetingRooms([]), 0);
assert.equal(minMeetingRooms([[1, 5], [5, 10]]), 1);
assert.equal(minMeetingRooms([[1, 10], [2, 9], [3, 8], [9, 12]]), 3);
```

</details>

</details>

---

<a id="algo-043"></a>
### algo-043. Subarray Sum Equals K

*Prefix sum + hash map · Medium*

Given an integer array `nums` (may include negatives) and an integer `k`, return the number of **contiguous subarrays** whose sum equals `k`.

```
subarraySum([1, 1, 1], 2) -> 2
subarraySum([1, 2, 3], 3) -> 2   // [1,2] and [3]
```

**Starter**

```ts
function subarraySum(nums: number[], k: number): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function subarraySum(nums: number[], k: number): number {
  const prefixCount = new Map<number, number>([[0, 1]]); // empty prefix
  let sum = 0;
  let count = 0;
  for (const x of nums) {
    sum += x;
    // A subarray ending here sums to k if an earlier prefix equals sum - k
    count += prefixCount.get(sum - k) ?? 0;
    prefixCount.set(sum, (prefixCount.get(sum) ?? 0) + 1);
  }
  return count;
}
```

**Why it works.** Brute force sums every subarray, O(n^2). With prefix sums, sum(i..j) = prefix[j] - prefix[i-1], so a subarray ending at j sums to k exactly when some earlier prefix equals prefix[j] - k. Count earlier prefixes in a hash map as you go, seeded with {0: 1} for subarrays starting at index 0. O(n) time, O(n) space. Trap: a sliding window does not work here because negatives break monotonicity.

**Say it.** I keep a running prefix sum and a map counting how often each prefix sum has appeared; at each index, the number of earlier prefixes equal to sum minus k is the number of subarrays ending here.

**Follow-up.** Q: Why not a sliding window? A: With negative numbers, extending the window can decrease the sum, so you cannot decide when to shrink; the window works only for all-positive arrays.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(subarraySum([1, 1, 1], 2), 2);
assert.equal(subarraySum([1, 2, 3], 3), 2);
assert.equal(subarraySum([1, -1, 0], 0), 3);
assert.equal(subarraySum([], 0), 0);
assert.equal(subarraySum([3, 4, 7, 2, -3, 1, 4, 2], 7), 4);
```

</details>

</details>

---

<a id="algo-044"></a>
### algo-044. Range Sum Query (Immutable)

*Prefix sum · Easy*

Implement class `NumArray`: the constructor takes an integer array `nums`, and `sumRange(left, right)` returns the sum of `nums[left..right]` inclusive. `sumRange` will be called many times, so make it O(1).

```
const a = new NumArray([-2, 0, 3, -5, 2, -1]);
a.sumRange(0, 2); // 1
a.sumRange(2, 5); // -1
a.sumRange(0, 5); // -3
```

**Starter**

```ts
class NumArray {
  constructor(nums: number[]) {}
  sumRange(left: number, right: number): number {
    return 0;
  }
}
```

<details>
<summary>Solution</summary>

```ts
class NumArray {
  private prefix: number[]; // prefix[i] = sum of nums[0..i-1]

  constructor(nums: number[]) {
    this.prefix = new Array<number>(nums.length + 1).fill(0);
    for (let i = 0; i < nums.length; i++) this.prefix[i + 1] = this.prefix[i] + nums[i];
  }

  sumRange(left: number, right: number): number {
    return this.prefix[right + 1] - this.prefix[left];
  }
}
```

**Why it works.** Summing the range on each call is O(n) per query. Precompute a prefix array of length n + 1 where prefix[i] is the sum of the first i elements; then any range sum is prefix[right + 1] - prefix[left]. O(n) preprocessing, O(1) per query, O(n) space. The extra leading 0 removes the left === 0 special case.

**Say it.** I precompute prefix sums once with a leading zero, so any range sum is just the difference of two prefix values in O(1).

**Follow-up.** Q: What if the array also gets point updates? A: Use a Fenwick tree (Binary Indexed Tree) or a segment tree: O(log n) for both update and range query.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const na = new NumArray([-2, 0, 3, -5, 2, -1]);
assert.equal(na.sumRange(0, 2), 1);
assert.equal(na.sumRange(2, 5), -1);
assert.equal(na.sumRange(0, 5), -3);
assert.equal(na.sumRange(3, 3), -5);
assert.equal(new NumArray([7]).sumRange(0, 0), 7);
```

</details>

</details>

---

<a id="algo-045"></a>
### algo-045. Longest Common Prefix

*Strings · Easy*

Write a function that returns the longest common prefix among an array of strings. If there is none, return `""`.

```
longestCommonPrefix(["flower","flow","flight"]) -> "fl"
longestCommonPrefix(["dog","racecar","car"])    -> ""
```

**Starter**

```ts
function longestCommonPrefix(strs: string[]): string {
  // TODO
  return '';
}
```

<details>
<summary>Solution</summary>

```ts
function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return '';
  const first = strs[0];
  for (let i = 0; i < first.length; i++) {
    for (const s of strs) {
      // Stop at the first column where a string ends or differs
      if (i === s.length || s[i] !== first[i]) return first.slice(0, i);
    }
  }
  return first;
}
```

**Why it works.** Vertical scanning compares column i across all strings and stops at the first mismatch or the end of the shortest string, so it never does more work than needed. O(S) time where S is the total number of characters (worst case all equal), O(1) extra space. An alternative is sorting and comparing only the first and last strings (O(S log n)). Trap: an empty array or an empty string in the array.

**Say it.** I compare the strings column by column against the first one and return the prefix as soon as any string ends or has a different character.

**Follow-up.** Q: What if you get many prefix queries against a fixed set of strings? A: Build a trie once; the common prefix is the path from the root while nodes have exactly one child and are not word ends.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(longestCommonPrefix(['flower', 'flow', 'flight']), 'fl');
assert.equal(longestCommonPrefix(['dog', 'racecar', 'car']), '');
assert.equal(longestCommonPrefix([]), '');
assert.equal(longestCommonPrefix(['alone']), 'alone');
assert.equal(longestCommonPrefix(['ab', 'a', '']), '');
assert.equal(longestCommonPrefix(['abc', 'abc']), 'abc');
```

</details>

</details>

---

<a id="algo-046"></a>
### algo-046. String Compression

*Run-length encoding · Easy*

Compress a string using counts of repeated characters: `"aabcccccaaa"` becomes `"a2b1c5a3"`. If the compressed string is **not shorter** than the original, return the original.

```
compress("aabcccccaaa") -> "a2b1c5a3"
compress("abc")         -> "abc"     // "a1b1c1" is longer
compress("aaaaaaaaaaaa") -> "a12"
```

**Starter**

```ts
function compress(s: string): string {
  // TODO
  return s;
}
```

<details>
<summary>Solution</summary>

```ts
function compress(s: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j < s.length && s[j] === s[i]) j++; // end of the current run
    parts.push(s[i] + String(j - i));
    i = j;
  }
  const compressed = parts.join('');
  return compressed.length < s.length ? compressed : s;
}
```

**Why it works.** Scan runs of equal characters with two indices: i marks the run start and j advances to the first different character, so each run produces char + length. Building with an array and join (or a single string builder) keeps it O(n); repeated string concatenation in some languages is O(n^2). O(n) time, O(n) space. Traps: multi-digit counts like 12, and returning the original when compression does not help.

**Say it.** I walk the string run by run, appending each character with its run length, and return the original if the result is not shorter.

**Follow-up.** Q: How would you do LeetCode 443 (compress a char array in place and return the new length)? A: Use read and write pointers: write the char, then the count digits only if count > 1; the write index never passes the read index.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(compress('aabcccccaaa'), 'a2b1c5a3');
assert.equal(compress('abc'), 'abc');
assert.equal(compress('aaaaaaaaaaaa'), 'a12');
assert.equal(compress(''), '');
assert.equal(compress('aabb'), 'aabb');
```

</details>

</details>

---

<a id="algo-047"></a>
### algo-047. Valid Palindrome II

*Two pointers · Easy*

Given a string `s`, return `true` if it can become a palindrome after deleting **at most one** character.

```
validPalindrome("aba")  -> true
validPalindrome("abca") -> true    // delete 'c'
validPalindrome("abc")  -> false
```

**Starter**

```ts
function validPalindrome(s: string): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
function isPalindromeRange(s: string, left: number, right: number): boolean {
  while (left < right) {
    if (s[left] !== s[right]) return false;
    left++;
    right--;
  }
  return true;
}

function validPalindrome(s: string): boolean {
  let left = 0;
  let right = s.length - 1;
  while (left < right) {
    if (s[left] !== s[right]) {
      // Use the one allowed deletion: skip either side
      return isPalindromeRange(s, left + 1, right) || isPalindromeRange(s, left, right - 1);
    }
    left++;
    right--;
  }
  return true;
}
```

**Why it works.** Brute force deletes each character in turn and checks the rest, O(n^2). With two pointers moving inward, everything matched so far is fine; at the first mismatch, one of those two characters must be deleted, so check whether s[left+1..right] or s[left..right-1] is a palindrome. O(n) time, O(1) space. Trap: trying only one of the two deletions.

**Say it.** I compare from both ends; at the first mismatch I try skipping the left or the right character and check whether the remaining middle is a palindrome.

**Follow-up.** Q: What if up to k deletions are allowed? A: It becomes DP: the string is valid if n - LPS(s) <= k, where LPS is the longest palindromic subsequence, O(n^2).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(validPalindrome('aba'), true);
assert.equal(validPalindrome('abca'), true);
assert.equal(validPalindrome('abc'), false);
assert.equal(validPalindrome(''), true);
assert.equal(validPalindrome('deeee'), true);
assert.equal(validPalindrome('cbbcc'), true);
assert.equal(validPalindrome('abccdba'), true);
assert.equal(validPalindrome('abcdba'), true);
assert.equal(validPalindrome('abcxyba'), false);
```

</details>

</details>

---

<a id="algo-048"></a>
### algo-048. Isomorphic Strings

*Hash map · Easy*

Two strings `s` and `t` are isomorphic if the characters in `s` can be replaced to get `t`, where each character maps to exactly one character, and no two characters map to the same one (order preserved). Return `true` if they are isomorphic.

```
isIsomorphic("egg", "add")     -> true
isIsomorphic("foo", "bar")     -> false
isIsomorphic("paper", "title") -> true
isIsomorphic("badc", "baba")   -> false
```

**Starter**

```ts
function isIsomorphic(s: string, t: string): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
function isIsomorphic(s: string, t: string): boolean {
  if (s.length !== t.length) return false;
  const sToT = new Map<string, string>();
  const tToS = new Map<string, string>();
  for (let i = 0; i < s.length; i++) {
    const a = s[i];
    const b = t[i];
    if ((sToT.has(a) && sToT.get(a) !== b) || (tToS.has(b) && tToS.get(b) !== a)) return false;
    sToT.set(a, b);
    tToS.set(b, a);
  }
  return true;
}
```

**Why it works.** The mapping must be a bijection, so check both directions: keep a map s->t and a map t->s and fail on any conflict. A single map misses cases like "badc" vs "baba" where two different characters map to the same one. O(n) time, O(k) space for the alphabet. Alternative: compare the "first-seen index" pattern of both strings.

**Say it.** I keep two maps, one in each direction, and fail as soon as a character would map to two different characters or two characters would map to the same one.

**Follow-up.** Q: How would you group a list of words by isomorphic pattern? A: Normalize each word to the pattern of first-occurrence indices (e.g. "paper" -> "0,1,0,3,4") and group by that key in a hash map.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(isIsomorphic('egg', 'add'), true);
assert.equal(isIsomorphic('foo', 'bar'), false);
assert.equal(isIsomorphic('paper', 'title'), true);
assert.equal(isIsomorphic('badc', 'baba'), false);
assert.equal(isIsomorphic('', ''), true);
assert.equal(isIsomorphic('ab', 'a'), false);
```

</details>

</details>

---

<a id="algo-049"></a>
### algo-049. Roman to Integer

*Strings · Easy*

Convert a Roman numeral (`I=1, V=5, X=10, L=50, C=100, D=500, M=1000`) to an integer. A smaller symbol before a larger one is subtracted (`IV = 4`, `IX = 9`, `XL = 40`, `XC = 90`, `CD = 400`, `CM = 900`). Input is valid, range 1-3999.

```
romanToInt("III")     -> 3
romanToInt("LVIII")   -> 58
romanToInt("MCMXCIV") -> 1994
```

**Starter**

```ts
function romanToInt(s: string): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

function romanToInt(s: string): number {
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const value = ROMAN[s[i]];
    const next = i + 1 < s.length ? ROMAN[s[i + 1]] : 0;
    // A symbol smaller than the one after it is subtractive
    total += value < next ? -value : value;
  }
  return total;
}
```

**Why it works.** Hard-coding the six subtractive pairs works but is clunky. The general rule: a symbol followed by a larger symbol is subtracted, otherwise added, so a single left-to-right pass comparing each value with the next one is enough. O(n) time, O(1) space. An equivalent trick is to scan right to left and subtract when the value is less than the previous (larger) one.

**Say it.** I scan left to right and add each symbol's value, except I subtract it when the next symbol is larger, which handles all the IV/IX-style cases.

**Follow-up.** Q: How do you convert an integer to Roman? A: Greedy over a table including the subtractive pairs (1000 M, 900 CM, 500 D, 400 CD, ... 4 IV, 1 I): repeatedly append the largest symbol that fits and subtract its value.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(romanToInt('III'), 3);
assert.equal(romanToInt('LVIII'), 58);
assert.equal(romanToInt('MCMXCIV'), 1994);
assert.equal(romanToInt('IV'), 4);
assert.equal(romanToInt('MMMCMXCIX'), 3999);
```

</details>

</details>

---

<a id="algo-050"></a>
### algo-050. Find All Anagrams in a String

*Sliding window · Medium*

Given strings `s` and `p` (lowercase letters), return all start indices of substrings of `s` that are anagrams of `p`, in increasing order.

```
findAnagrams("cbaebabacd", "abc") -> [0, 6]   // "cba", "bac"
findAnagrams("abab", "ab")        -> [0, 1, 2]
```

**Starter**

```ts
function findAnagrams(s: string, p: string): number[] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
function findAnagrams(s: string, p: string): number[] {
  const result: number[] = [];
  const m = p.length;
  if (m === 0 || m > s.length) return result;
  // diff[c] = count in window - count in p; window is an anagram when all are 0
  const diff = new Array(26).fill(0);
  for (let i = 0; i < m; i++) {
    diff[p.charCodeAt(i) - 97]--;
    diff[s.charCodeAt(i) - 97]++;
  }
  let nonZero = diff.filter((d) => d !== 0).length;

  const bump = (c: number, delta: number) => {
    if (diff[c] === 0) nonZero++;
    diff[c] += delta;
    if (diff[c] === 0) nonZero--;
  };

  for (let start = 0; ; start++) {
    if (nonZero === 0) result.push(start);
    const end = start + m;
    if (end >= s.length) break;
    bump(s.charCodeAt(end) - 97, 1); // char entering
    bump(s.charCodeAt(start) - 97, -1); // char leaving
  }
  return result;
}
```

**Why it works.** Brute force sorts or counts every window of length |p|, O(n * m). Instead keep a fixed-size window and a single array of count differences (window minus p), updating it in O(1) as one character enters and one leaves. Tracking how many letters have a non-zero difference tells you instantly when the window is an anagram. O(n) time, O(1) space (26 counters) besides the output.

**Say it.** I slide a window the length of p over s, keeping a count difference array updated in O(1) per step, and record the start index whenever all differences are zero.

**Follow-up.** Q: What if the alphabet is all of Unicode? A: Replace the 26-slot array with a Map of differences and delete keys that reach 0; the window is an anagram when the map is empty.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(findAnagrams('cbaebabacd', 'abc'), [0, 6]);
assert.deepEqual(findAnagrams('abab', 'ab'), [0, 1, 2]);
assert.deepEqual(findAnagrams('a', 'ab'), []);
assert.deepEqual(findAnagrams('aaaa', 'a'), [0, 1, 2, 3]);
assert.deepEqual(findAnagrams('xyz', 'abc'), []);
```

</details>

</details>

---

<a id="algo-051"></a>
### algo-051. Maximum Depth of Binary Tree

*Trees (DFS) · Easy*

Given the `root` of a binary tree, return its **maximum depth**: the number of nodes on the longest path from the root down to a leaf.

- `[3,9,20,null,null,15,7]` -> `3`
- `[1,null,2]` -> `2`
- `[]` -> `0`

**Starter**

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

function maxDepth(root: TreeNode | null): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

// Build a tree from LeetCode-style level-order array (null = missing child).
function fromArray(values: (number | null)[]): TreeNode | null {
  if (values.length === 0 || values[0] === null) return null;
  const root = new TreeNode(values[0]);
  const queue: TreeNode[] = [root];
  let head = 0;
  let i = 1;
  while (i < values.length) {
    const node = queue[head++];
    const l = values[i++];
    if (l !== undefined && l !== null) {
      node.left = new TreeNode(l);
      queue.push(node.left);
    }
    const r = values[i++];
    if (r !== undefined && r !== null) {
      node.right = new TreeNode(r);
      queue.push(node.right);
    }
  }
  return root;
}

function maxDepth(root: TreeNode | null): number {
  if (root === null) return 0;
  return 1 + Math.max(maxDepth(root.left), maxDepth(root.right));
}
```

**Why it works.** Post-order DFS: the depth of a node is 1 plus the larger depth of its two subtrees, and an empty tree has depth 0. There is no real brute force to beat here; the point is to see the recursive definition. Every node is visited once: O(n) time, O(h) space for the recursion stack (O(n) for a skewed tree, O(log n) if balanced). Trap: forgetting the `null` base case or returning 1 for an empty tree.

**Say it.** The depth of a tree is one plus the max depth of its subtrees, with an empty tree being zero, so I recurse once per node: O(n) time and O(h) stack space.

**Follow-up.** Q: The tree can be 100,000 nodes deep and recursion overflows the stack. What do you do? A: Use iterative BFS: process the tree level by level with a queue and count the levels. O(n) time, O(width) space, no recursion.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(maxDepth(fromArray([3, 9, 20, null, null, 15, 7])), 3);
assert.equal(maxDepth(fromArray([1, null, 2])), 2);
assert.equal(maxDepth(fromArray([])), 0);
assert.equal(maxDepth(fromArray([1])), 1);
assert.equal(maxDepth(fromArray([1, 2, null, 3, null, 4])), 4);
```

</details>

</details>

---

<a id="algo-052"></a>
### algo-052. Invert Binary Tree

*Trees (DFS) · Easy*

Given the `root` of a binary tree, invert it (mirror it left-to-right) and return the root.

- `[4,2,7,1,3,6,9]` -> `[4,7,2,9,6,3,1]`
- `[2,1,3]` -> `[2,3,1]`
- `[]` -> `[]`

**Starter**

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

function invertTree(root: TreeNode | null): TreeNode | null {
  // TODO
  return root;
}
```

<details>
<summary>Solution</summary>

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

// Build a tree from LeetCode-style level-order array (null = missing child).
function fromArray(values: (number | null)[]): TreeNode | null {
  if (values.length === 0 || values[0] === null) return null;
  const root = new TreeNode(values[0]);
  const queue: TreeNode[] = [root];
  let head = 0;
  let i = 1;
  while (i < values.length) {
    const node = queue[head++];
    const l = values[i++];
    if (l !== undefined && l !== null) {
      node.left = new TreeNode(l);
      queue.push(node.left);
    }
    const r = values[i++];
    if (r !== undefined && r !== null) {
      node.right = new TreeNode(r);
      queue.push(node.right);
    }
  }
  return root;
}

function invertTree(root: TreeNode | null): TreeNode | null {
  if (root === null) return null;
  const left = invertTree(root.left);
  root.left = invertTree(root.right);
  root.right = left;
  return root;
}
```

**Why it works.** Swap the children of every node; doing it recursively mirrors each subtree before (or after) swapping. Each node is touched once: O(n) time, O(h) space for the recursion. Trap: overwriting `root.left` before saving it, which makes both children point to the same subtree.

**Say it.** I recursively invert both subtrees and swap them at each node, saving one side in a temp variable first, so it's O(n) time and O(h) stack.

**Follow-up.** Q: Can you do it without recursion? A: Yes, BFS with a queue (or DFS with a stack): pop a node, swap its children, push the non-null children. Same O(n) time.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
function toArray(root: TreeNode | null): (number | null)[] {
  const out: (number | null)[] = [];
  const q: (TreeNode | null)[] = [root];
  for (let i = 0; i < q.length; i++) {
    const n = q[i];
    out.push(n ? n.val : null);
    if (n) q.push(n.left, n.right);
  }
  while (out.length && out[out.length - 1] === null) out.pop();
  return out;
}
assert.deepEqual(toArray(invertTree(fromArray([4, 2, 7, 1, 3, 6, 9]))), [4, 7, 2, 9, 6, 3, 1]);
assert.deepEqual(toArray(invertTree(fromArray([2, 1, 3]))), [2, 3, 1]);
assert.equal(invertTree(fromArray([])), null);
assert.deepEqual(toArray(invertTree(fromArray([1, 2]))), [1, null, 2]);
```

</details>

</details>

---

<a id="algo-053"></a>
### algo-053. Same Tree

*Trees (DFS) · Easy*

Given the roots of two binary trees `p` and `q`, return `true` if they are structurally identical and every corresponding node has the same value.

- `p = [1,2,3], q = [1,2,3]` -> `true`
- `p = [1,2], q = [1,null,2]` -> `false`
- `p = [1,2,1], q = [1,1,2]` -> `false`

**Starter**

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

function isSameTree(p: TreeNode | null, q: TreeNode | null): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

// Build a tree from LeetCode-style level-order array (null = missing child).
function fromArray(values: (number | null)[]): TreeNode | null {
  if (values.length === 0 || values[0] === null) return null;
  const root = new TreeNode(values[0]);
  const queue: TreeNode[] = [root];
  let head = 0;
  let i = 1;
  while (i < values.length) {
    const node = queue[head++];
    const l = values[i++];
    if (l !== undefined && l !== null) {
      node.left = new TreeNode(l);
      queue.push(node.left);
    }
    const r = values[i++];
    if (r !== undefined && r !== null) {
      node.right = new TreeNode(r);
      queue.push(node.right);
    }
  }
  return root;
}

function isSameTree(p: TreeNode | null, q: TreeNode | null): boolean {
  if (p === null && q === null) return true;
  if (p === null || q === null || p.val !== q.val) return false;
  return isSameTree(p.left, q.left) && isSameTree(p.right, q.right);
}
```

**Why it works.** Walk both trees in lockstep: two nulls match, one null or different values do not, otherwise both subtree pairs must match. Comparing serialized traversals would also work but costs extra memory and needs null markers to be correct. Lockstep DFS is O(n) time and O(h) space and stops at the first mismatch. Trap: checking only values and not structure (`[1,2]` vs `[1,null,2]`).

**Say it.** I recurse on both trees at once: both null is a match, one null or different values is a mismatch, otherwise I compare left with left and right with right. O(n) time, O(h) space.

**Follow-up.** Q: How would you check if two trees are mirror images of each other? A: Same recursion, but compare `p.left` with `q.right` and `p.right` with `q.left` (this is the "Symmetric Tree" problem).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(isSameTree(fromArray([1, 2, 3]), fromArray([1, 2, 3])), true);
assert.equal(isSameTree(fromArray([1, 2]), fromArray([1, null, 2])), false);
assert.equal(isSameTree(fromArray([1, 2, 1]), fromArray([1, 1, 2])), false);
assert.equal(isSameTree(fromArray([]), fromArray([])), true);
assert.equal(isSameTree(fromArray([1]), fromArray([])), false);
```

</details>

</details>

---

<a id="algo-054"></a>
### algo-054. Subtree of Another Tree

*Trees (DFS) · Easy*

Given the roots of two binary trees `root` and `subRoot`, return `true` if `root` contains a subtree with exactly the same structure and values as `subRoot`. A subtree is a node plus **all** of its descendants.

- `root = [3,4,5,1,2], subRoot = [4,1,2]` -> `true`
- `root = [3,4,5,1,2,null,null,null,null,0], subRoot = [4,1,2]` -> `false`

**Starter**

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

function isSubtree(root: TreeNode | null, subRoot: TreeNode | null): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

// Build a tree from LeetCode-style level-order array (null = missing child).
function fromArray(values: (number | null)[]): TreeNode | null {
  if (values.length === 0 || values[0] === null) return null;
  const root = new TreeNode(values[0]);
  const queue: TreeNode[] = [root];
  let head = 0;
  let i = 1;
  while (i < values.length) {
    const node = queue[head++];
    const l = values[i++];
    if (l !== undefined && l !== null) {
      node.left = new TreeNode(l);
      queue.push(node.left);
    }
    const r = values[i++];
    if (r !== undefined && r !== null) {
      node.right = new TreeNode(r);
      queue.push(node.right);
    }
  }
  return root;
}

function isSameTree(p: TreeNode | null, q: TreeNode | null): boolean {
  if (p === null && q === null) return true;
  if (p === null || q === null || p.val !== q.val) return false;
  return isSameTree(p.left, q.left) && isSameTree(p.right, q.right);
}

function isSubtree(root: TreeNode | null, subRoot: TreeNode | null): boolean {
  if (subRoot === null) return true;
  if (root === null) return false;
  if (isSameTree(root, subRoot)) return true;
  return isSubtree(root.left, subRoot) || isSubtree(root.right, subRoot);
}
```

**Why it works.** For every node in `root`, check whether the tree starting there is identical to `subRoot` (reusing Same Tree). That is O(m * n) time in the worst case and O(h) space, which is the expected interview answer. The optimal O(m + n) approach serializes both trees with null markers and value delimiters and runs a substring search (KMP) or compares Merkle-style subtree hashes. Trap: a matching node whose descendants differ (the second example) is not a subtree.

**Say it.** I DFS through the big tree and at each node run a same-tree check against subRoot; that's O(m times n) worst case, and can be made linear by serializing both trees and doing a substring search.

**Follow-up.** Q: How do you make it linear? A: Serialize each tree in preorder with explicit null markers and separators like `,4,1,#,#,2,#,#`, then check substring containment with KMP: O(m + n). Alternatively hash each subtree bottom-up and compare hashes.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(isSubtree(fromArray([3, 4, 5, 1, 2]), fromArray([4, 1, 2])), true);
assert.equal(isSubtree(fromArray([3, 4, 5, 1, 2, null, null, null, null, 0]), fromArray([4, 1, 2])), false);
assert.equal(isSubtree(fromArray([1, 1]), fromArray([1])), true);
assert.equal(isSubtree(fromArray([]), fromArray([1])), false);
assert.equal(isSubtree(fromArray([12]), fromArray([2])), false);
```

</details>

</details>

---

<a id="algo-055"></a>
### algo-055. Binary Tree Level Order Traversal

*Trees (BFS) · Medium*

Given the `root` of a binary tree, return the level order traversal of its values: left to right, level by level, one array per level.

- `[3,9,20,null,null,15,7]` -> `[[3],[9,20],[15,7]]`
- `[1]` -> `[[1]]`
- `[]` -> `[]`

**Starter**

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

function levelOrder(root: TreeNode | null): number[][] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

// Build a tree from LeetCode-style level-order array (null = missing child).
function fromArray(values: (number | null)[]): TreeNode | null {
  if (values.length === 0 || values[0] === null) return null;
  const root = new TreeNode(values[0]);
  const queue: TreeNode[] = [root];
  let head = 0;
  let i = 1;
  while (i < values.length) {
    const node = queue[head++];
    const l = values[i++];
    if (l !== undefined && l !== null) {
      node.left = new TreeNode(l);
      queue.push(node.left);
    }
    const r = values[i++];
    if (r !== undefined && r !== null) {
      node.right = new TreeNode(r);
      queue.push(node.right);
    }
  }
  return root;
}

function levelOrder(root: TreeNode | null): number[][] {
  const result: number[][] = [];
  let level: TreeNode[] = root ? [root] : [];
  while (level.length > 0) {
    result.push(level.map((n) => n.val));
    const next: TreeNode[] = [];
    for (const node of level) {
      if (node.left) next.push(node.left);
      if (node.right) next.push(node.right);
    }
    level = next;
  }
  return result;
}
```

**Why it works.** BFS processes nodes in order of distance from the root; keeping the current level as its own array (or snapshotting `queue.length` before the loop) groups values per level. Each node is enqueued and dequeued once: O(n) time, O(w) extra space where w is the max width (up to n/2). Trap: using `Array.prototype.shift()` on a big queue is O(n) per call in JS, so swap level arrays or use a head index instead.

**Say it.** I do BFS one level at a time: the current level array produces one row of values and builds the next level from its children. O(n) time, O(width) space.

**Follow-up.** Q: Return the levels in zigzag order (left-to-right, then right-to-left). A: Same BFS; reverse every other level's values before pushing (or fill each row from the opposite end). Still O(n).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(levelOrder(fromArray([3, 9, 20, null, null, 15, 7])), [[3], [9, 20], [15, 7]]);
assert.deepEqual(levelOrder(fromArray([1])), [[1]]);
assert.deepEqual(levelOrder(fromArray([])), []);
assert.deepEqual(levelOrder(fromArray([1, 2, null, 3, null, 4])), [[1], [2], [3], [4]]);
```

</details>

</details>

---

<a id="algo-056"></a>
### algo-056. Validate Binary Search Tree

*Trees (BST) · Medium*

Given the `root` of a binary tree, determine whether it is a valid **binary search tree**: every node's left subtree holds only values strictly less than the node, the right subtree only values strictly greater, and both subtrees are BSTs themselves.

- `[2,1,3]` -> `true`
- `[5,1,4,null,null,3,6]` -> `false` (4 is in the right subtree of 5)
- `[5,4,6,null,null,3,7]` -> `false` (3 is in the right subtree of 5)

**Starter**

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

function isValidBST(root: TreeNode | null): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

// Build a tree from LeetCode-style level-order array (null = missing child).
function fromArray(values: (number | null)[]): TreeNode | null {
  if (values.length === 0 || values[0] === null) return null;
  const root = new TreeNode(values[0]);
  const queue: TreeNode[] = [root];
  let head = 0;
  let i = 1;
  while (i < values.length) {
    const node = queue[head++];
    const l = values[i++];
    if (l !== undefined && l !== null) {
      node.left = new TreeNode(l);
      queue.push(node.left);
    }
    const r = values[i++];
    if (r !== undefined && r !== null) {
      node.right = new TreeNode(r);
      queue.push(node.right);
    }
  }
  return root;
}

function isValidBST(root: TreeNode | null): boolean {
  const check = (node: TreeNode | null, low: number, high: number): boolean => {
    if (node === null) return true;
    if (node.val <= low || node.val >= high) return false;
    return check(node.left, low, node.val) && check(node.right, node.val, high);
  };
  return check(root, -Infinity, Infinity);
}
```

**Why it works.** Pass down an open interval `(low, high)` that every node must fall into: going left tightens `high` to the parent's value, going right tightens `low`. The common wrong answer only compares a node with its direct children, which misses violations deeper down (third example). Each node is checked once: O(n) time, O(h) space. Alternative: an in-order traversal of a valid BST is strictly increasing.

**Say it.** I DFS while carrying the allowed range for each node, narrowing the upper bound when I go left and the lower bound when I go right; any node outside its range fails. O(n) time, O(h) space.

**Follow-up.** Q: What's another way to do it? A: In-order traversal while remembering the previous value; if any value is less than or equal to the previous one, it is not a BST. Same O(n) time and you can stop early.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(isValidBST(fromArray([2, 1, 3])), true);
assert.equal(isValidBST(fromArray([5, 1, 4, null, null, 3, 6])), false);
assert.equal(isValidBST(fromArray([5, 4, 6, null, null, 3, 7])), false);
assert.equal(isValidBST(fromArray([2, 2, 2])), false);
assert.equal(isValidBST(fromArray([])), true);
assert.equal(isValidBST(fromArray([-2147483648, null, 2147483647])), true);
```

</details>

</details>

---

<a id="algo-057"></a>
### algo-057. Lowest Common Ancestor of a BST

*Trees (BST) · Easy*

Given a binary **search** tree and two values `p` and `q` that both exist in it, return the value of their lowest common ancestor: the deepest node that has both `p` and `q` as descendants (a node is a descendant of itself).

- `root = [6,2,8,0,4,7,9,null,null,3,5], p = 2, q = 8` -> `6`
- same tree, `p = 2, q = 4` -> `2`

**Starter**

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

function lowestCommonAncestor(root: TreeNode | null, p: number, q: number): number | null {
  // TODO
  return null;
}
```

<details>
<summary>Solution</summary>

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

// Build a tree from LeetCode-style level-order array (null = missing child).
function fromArray(values: (number | null)[]): TreeNode | null {
  if (values.length === 0 || values[0] === null) return null;
  const root = new TreeNode(values[0]);
  const queue: TreeNode[] = [root];
  let head = 0;
  let i = 1;
  while (i < values.length) {
    const node = queue[head++];
    const l = values[i++];
    if (l !== undefined && l !== null) {
      node.left = new TreeNode(l);
      queue.push(node.left);
    }
    const r = values[i++];
    if (r !== undefined && r !== null) {
      node.right = new TreeNode(r);
      queue.push(node.right);
    }
  }
  return root;
}

function lowestCommonAncestor(root: TreeNode | null, p: number, q: number): number | null {
  let node = root;
  while (node !== null) {
    if (p < node.val && q < node.val) node = node.left;
    else if (p > node.val && q > node.val) node = node.right;
    else return node.val; // p and q split here (or one of them is this node)
  }
  return null;
}
```

**Why it works.** Use the BST ordering: if both values are smaller than the current node, the LCA is in the left subtree; if both are larger, it is in the right; otherwise they split here, so this node is the LCA. A generic binary-tree LCA (or storing both root-to-node paths) works but ignores the ordering. This walk is O(h) time and O(1) space. Trap: forgetting that a node can be its own ancestor (`p = 2, q = 4` -> `2`).

**Say it.** Starting at the root I move left if both values are smaller, right if both are larger, and the first node where they split is the answer. O(h) time, O(1) space.

**Follow-up.** Q: What if it's a plain binary tree, not a BST? A: Recursive DFS: return the node if it is p or q; recurse left and right; if both sides return non-null the current node is the LCA, otherwise pass up whichever side is non-null. O(n) time.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const t = fromArray([6, 2, 8, 0, 4, 7, 9, null, null, 3, 5]);
assert.equal(lowestCommonAncestor(t, 2, 8), 6);
assert.equal(lowestCommonAncestor(t, 2, 4), 2);
assert.equal(lowestCommonAncestor(t, 3, 5), 4);
assert.equal(lowestCommonAncestor(t, 7, 9), 8);
assert.equal(lowestCommonAncestor(fromArray([2, 1]), 2, 1), 2);
```

</details>

</details>

---

<a id="algo-058"></a>
### algo-058. Kth Smallest Element in a BST

*Trees (BST) · Medium*

Given the `root` of a binary search tree and an integer `k`, return the `k`-th smallest value (1-indexed) in the tree.

- `root = [3,1,4,null,2], k = 1` -> `1`
- `root = [5,3,6,2,4,null,null,1], k = 3` -> `3`

**Starter**

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

function kthSmallest(root: TreeNode | null, k: number): number {
  // TODO
  return -1;
}
```

<details>
<summary>Solution</summary>

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

// Build a tree from LeetCode-style level-order array (null = missing child).
function fromArray(values: (number | null)[]): TreeNode | null {
  if (values.length === 0 || values[0] === null) return null;
  const root = new TreeNode(values[0]);
  const queue: TreeNode[] = [root];
  let head = 0;
  let i = 1;
  while (i < values.length) {
    const node = queue[head++];
    const l = values[i++];
    if (l !== undefined && l !== null) {
      node.left = new TreeNode(l);
      queue.push(node.left);
    }
    const r = values[i++];
    if (r !== undefined && r !== null) {
      node.right = new TreeNode(r);
      queue.push(node.right);
    }
  }
  return root;
}

function kthSmallest(root: TreeNode | null, k: number): number {
  // Iterative in-order traversal: visits BST values in sorted order.
  const stack: TreeNode[] = [];
  let node = root;
  while (node !== null || stack.length > 0) {
    while (node !== null) {
      stack.push(node);
      node = node.left;
    }
    node = stack.pop()!;
    if (--k === 0) return node.val;
    node = node.right;
  }
  throw new Error('k is larger than the number of nodes');
}
```

**Why it works.** In-order traversal of a BST yields values in ascending order, so the k-th visited node is the answer. Brute force collects all values and sorts them (O(n log n)); the in-order walk is already sorted and can stop early, giving O(h + k) time and O(h) space. The iterative stack version makes stopping early easy. Trap: k is 1-indexed.

**Say it.** In-order traversal of a BST is sorted, so I walk it iteratively with a stack and return the k-th node I pop. O(h + k) time, O(h) space.

**Follow-up.** Q: The tree is modified often and kthSmallest is called frequently. How do you optimize? A: Store the size of each node's subtree. Then at each node compare k with `leftSize + 1` and go left or right, giving O(h) per query; update sizes on insert/delete.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(kthSmallest(fromArray([3, 1, 4, null, 2]), 1), 1);
assert.equal(kthSmallest(fromArray([5, 3, 6, 2, 4, null, null, 1]), 3), 3);
assert.equal(kthSmallest(fromArray([5, 3, 6, 2, 4, null, null, 1]), 6), 6);
assert.equal(kthSmallest(fromArray([1]), 1), 1);
assert.throws(() => kthSmallest(fromArray([1]), 2));
```

</details>

</details>

---

<a id="algo-059"></a>
### algo-059. Diameter of Binary Tree

*Trees (DFS) · Easy*

Given the `root` of a binary tree, return the length of its **diameter**: the number of edges on the longest path between any two nodes. The path may or may not pass through the root.

- `[1,2,3,4,5]` -> `3` (path 4-2-1-3 or 5-2-1-3)
- `[1,2]` -> `1`

**Starter**

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

function diameterOfBinaryTree(root: TreeNode | null): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

// Build a tree from LeetCode-style level-order array (null = missing child).
function fromArray(values: (number | null)[]): TreeNode | null {
  if (values.length === 0 || values[0] === null) return null;
  const root = new TreeNode(values[0]);
  const queue: TreeNode[] = [root];
  let head = 0;
  let i = 1;
  while (i < values.length) {
    const node = queue[head++];
    const l = values[i++];
    if (l !== undefined && l !== null) {
      node.left = new TreeNode(l);
      queue.push(node.left);
    }
    const r = values[i++];
    if (r !== undefined && r !== null) {
      node.right = new TreeNode(r);
      queue.push(node.right);
    }
  }
  return root;
}

function diameterOfBinaryTree(root: TreeNode | null): number {
  let best = 0;
  // Returns the height (in nodes) of the subtree, updating best on the way.
  const height = (node: TreeNode | null): number => {
    if (node === null) return 0;
    const l = height(node.left);
    const r = height(node.right);
    best = Math.max(best, l + r); // longest path that bends at this node
    return 1 + Math.max(l, r);
  };
  height(root);
  return best;
}
```

**Why it works.** The longest path bends at some node, and its length there is leftHeight + rightHeight. Brute force computes heights separately for every node (O(n^2) on skewed trees); instead, one post-order DFS returns each subtree's height and updates a global best along the way: O(n) time, O(h) space. Trap: assuming the diameter passes through the root.

**Say it.** One post-order DFS returns heights; at every node I update the answer with left height plus right height, because the longest path must bend somewhere. O(n) time, O(h) space.

**Follow-up.** Q: How would you find the maximum path *sum* (node values can be negative)? A: Same pattern: the DFS returns the best downward gain `node.val + max(0, leftGain, rightGain)` and updates a global with `node.val + max(0,leftGain) + max(0,rightGain)` (Binary Tree Maximum Path Sum).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(diameterOfBinaryTree(fromArray([1, 2, 3, 4, 5])), 3);
assert.equal(diameterOfBinaryTree(fromArray([1, 2])), 1);
assert.equal(diameterOfBinaryTree(fromArray([1])), 0);
assert.equal(diameterOfBinaryTree(fromArray([])), 0);
// longest path does not go through the root
assert.equal(diameterOfBinaryTree(fromArray([1, 2, null, 3, 4, 5, null, null, 6, 7, null, null, 8])), 6);
```

</details>

</details>

---

<a id="algo-060"></a>
### algo-060. Path Sum

*Trees (DFS) · Easy*

Given the `root` of a binary tree and an integer `targetSum`, return `true` if there is a **root-to-leaf** path whose values add up to `targetSum`. A leaf has no children.

- `root = [5,4,8,11,null,13,4,7,2,null,null,null,1], targetSum = 22` -> `true` (5-4-11-2)
- `root = [1,2,3], targetSum = 5` -> `false`
- `root = [], targetSum = 0` -> `false`

**Starter**

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

function hasPathSum(root: TreeNode | null, targetSum: number): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
class TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
  constructor(val = 0, left: TreeNode | null = null, right: TreeNode | null = null) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}

// Build a tree from LeetCode-style level-order array (null = missing child).
function fromArray(values: (number | null)[]): TreeNode | null {
  if (values.length === 0 || values[0] === null) return null;
  const root = new TreeNode(values[0]);
  const queue: TreeNode[] = [root];
  let head = 0;
  let i = 1;
  while (i < values.length) {
    const node = queue[head++];
    const l = values[i++];
    if (l !== undefined && l !== null) {
      node.left = new TreeNode(l);
      queue.push(node.left);
    }
    const r = values[i++];
    if (r !== undefined && r !== null) {
      node.right = new TreeNode(r);
      queue.push(node.right);
    }
  }
  return root;
}

function hasPathSum(root: TreeNode | null, targetSum: number): boolean {
  if (root === null) return false;
  const remaining = targetSum - root.val;
  if (root.left === null && root.right === null) return remaining === 0;
  return hasPathSum(root.left, remaining) || hasPathSum(root.right, remaining);
}
```

**Why it works.** DFS from the root while subtracting each value from the target; when you reach a leaf, check whether the remainder is exactly 0. Every node is visited at most once: O(n) time, O(h) space. Traps: an empty tree has no path (even for target 0), and the check must happen only at leaves, not at a node with one missing child (`[1,2]` with target 1 is `false`).

**Say it.** I DFS down, subtracting each node's value from the target, and only at a leaf do I check if what's left is zero. O(n) time, O(h) space.

**Follow-up.** Q: Count paths that sum to the target where a path can start and end anywhere going downward? A: DFS with a prefix-sum hash map of sums on the current root path: at each node add `count[currSum - target]`, recurse, then remove `currSum` when backtracking. O(n) time (Path Sum III).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(hasPathSum(fromArray([5, 4, 8, 11, null, 13, 4, 7, 2, null, null, null, 1]), 22), true);
assert.equal(hasPathSum(fromArray([1, 2, 3]), 5), false);
assert.equal(hasPathSum(fromArray([]), 0), false);
assert.equal(hasPathSum(fromArray([1, 2]), 1), false);
assert.equal(hasPathSum(fromArray([-2, null, -3]), -5), true);
```

</details>

</details>

---

<a id="algo-061"></a>
### algo-061. Kth Largest Element in an Array

*Heap / priority queue · Medium*

Given an integer array `nums` and an integer `k`, return the `k`-th largest element (in sorted order, so duplicates count). Try to do better than sorting.

- `nums = [3,2,1,5,6,4], k = 2` -> `5`
- `nums = [3,2,3,1,2,4,5,5,6], k = 4` -> `4`

JavaScript has no built-in heap; write a small one.

**Starter**

```ts
function findKthLargest(nums: number[], k: number): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
// Minimal binary min-heap ordered by a comparator.
class MinHeap<T> {
  private data: T[] = [];
  private less: (a: T, b: T) => boolean;
  constructor(less: (a: T, b: T) => boolean) {
    this.less = less;
  }
  get size(): number {
    return this.data.length;
  }
  peek(): T | undefined {
    return this.data[0];
  }
  push(x: T): void {
    const d = this.data;
    d.push(x);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(d[i], d[p])) break;
      [d[i], d[p]] = [d[p], d[i]];
      i = p;
    }
  }
  pop(): T | undefined {
    const d = this.data;
    if (d.length === 0) return undefined;
    const top = d[0];
    const last = d.pop()!;
    if (d.length > 0) {
      d[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < d.length && this.less(d[l], d[m])) m = l;
        if (r < d.length && this.less(d[r], d[m])) m = r;
        if (m === i) break;
        [d[i], d[m]] = [d[m], d[i]];
        i = m;
      }
    }
    return top;
  }
}


function findKthLargest(nums: number[], k: number): number {
  // Keep the k largest values seen so far; the root is the smallest of them.
  const heap = new MinHeap<number>((a, b) => a < b);
  for (const n of nums) {
    heap.push(n);
    if (heap.size > k) heap.pop();
  }
  return heap.peek()!;
}
```

**Why it works.** Brute force sorts the array and indexes `n - k`: O(n log n). A min-heap capped at size `k` keeps the k largest values seen so far, and its root is exactly the k-th largest: O(n log k) time, O(k) space. Quickselect gives O(n) average time (O(n^2) worst case) and O(1) extra space. Trap: using a max-heap of all n elements and popping k times works but is O(n + k log n) with O(n) memory; the size-k min-heap is the standard answer.

**Say it.** I keep a min-heap of size k: push every number and pop when it grows past k, so the heap holds the k largest and its top is the answer. O(n log k) time, O(k) space.

**Follow-up.** Q: Can you get linear time? A: Quickselect: partition around a random pivot like quicksort, then recurse only into the side that contains index n - k. O(n) average, O(n^2) worst case (median-of-medians makes it worst-case linear but is rarely asked).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(findKthLargest([3, 2, 1, 5, 6, 4], 2), 5);
assert.equal(findKthLargest([3, 2, 3, 1, 2, 4, 5, 5, 6], 4), 4);
assert.equal(findKthLargest([1], 1), 1);
assert.equal(findKthLargest([-1, -1], 2), -1);
assert.equal(findKthLargest([7, 10, 4, 3, 20, 15], 6), 3);
```

</details>

</details>

---

<a id="algo-062"></a>
### algo-062. K Closest Points to Origin

*Heap / priority queue · Medium*

Given an array of `points` where `points[i] = [x, y]` and an integer `k`, return the `k` points closest to the origin `(0, 0)` by Euclidean distance. Any order is accepted.

- `points = [[1,3],[-2,2]], k = 1` -> `[[-2,2]]`
- `points = [[3,3],[5,-1],[-2,4]], k = 2` -> `[[3,3],[-2,4]]`

**Starter**

```ts
function kClosest(points: number[][], k: number): number[][] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
// Minimal binary min-heap ordered by a comparator.
class MinHeap<T> {
  private data: T[] = [];
  private less: (a: T, b: T) => boolean;
  constructor(less: (a: T, b: T) => boolean) {
    this.less = less;
  }
  get size(): number {
    return this.data.length;
  }
  peek(): T | undefined {
    return this.data[0];
  }
  push(x: T): void {
    const d = this.data;
    d.push(x);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(d[i], d[p])) break;
      [d[i], d[p]] = [d[p], d[i]];
      i = p;
    }
  }
  pop(): T | undefined {
    const d = this.data;
    if (d.length === 0) return undefined;
    const top = d[0];
    const last = d.pop()!;
    if (d.length > 0) {
      d[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < d.length && this.less(d[l], d[m])) m = l;
        if (r < d.length && this.less(d[r], d[m])) m = r;
        if (m === i) break;
        [d[i], d[m]] = [d[m], d[i]];
        i = m;
      }
    }
    return top;
  }
}


function kClosest(points: number[][], k: number): number[][] {
  const dist = (p: number[]) => p[0] * p[0] + p[1] * p[1];
  // Max-heap by distance (inverted comparator), capped at k elements.
  const heap = new MinHeap<number[]>((a, b) => dist(a) > dist(b));
  for (const p of points) {
    heap.push(p);
    if (heap.size > k) heap.pop(); // drop the farthest
  }
  const result: number[][] = [];
  while (heap.size > 0) result.push(heap.pop()!);
  return result;
}
```

**Why it works.** Brute force sorts all points by distance: O(n log n). Keep a max-heap of size `k` keyed by squared distance; whenever it exceeds `k`, evict the farthest point, so the heap ends with the k closest: O(n log k) time, O(k) space. Compare squared distances to avoid `Math.sqrt` and floating-point noise. Quickselect is O(n) on average.

**Say it.** I keep a max-heap of the k closest points by squared distance and evict the farthest whenever it grows past k. O(n log k) time, O(k) space, and no square roots needed.

**Follow-up.** Q: Points arrive as an endless stream; how do you always know the current k closest? A: The same size-k max-heap works online: each new point is compared with the heap top (the farthest of the k) and replaces it only if closer. O(log k) per point.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const sorted = (a: number[][]) => [...a].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
assert.deepEqual(kClosest([[1, 3], [-2, 2]], 1), [[-2, 2]]);
assert.deepEqual(sorted(kClosest([[3, 3], [5, -1], [-2, 4]], 2)), sorted([[3, 3], [-2, 4]]));
assert.deepEqual(sorted(kClosest([[0, 1], [1, 0]], 2)), [[0, 1], [1, 0]]);
assert.deepEqual(kClosest([[2, 2], [1, 1], [3, 3], [0, 0]], 1), [[0, 0]]);
```

</details>

</details>

---

<a id="algo-063"></a>
### algo-063. Merge k Sorted Lists

*Heap / priority queue · Hard*

You are given `k` sorted arrays of integers (standing in for sorted linked lists). Merge them into one sorted array.

- `[[1,4,5],[1,3,4],[2,6]]` -> `[1,1,2,3,4,4,5,6]`
- `[]` -> `[]`
- `[[]]` -> `[]`

**Starter**

```ts
function mergeKLists(lists: number[][]): number[] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
// Minimal binary min-heap ordered by a comparator.
class MinHeap<T> {
  private data: T[] = [];
  private less: (a: T, b: T) => boolean;
  constructor(less: (a: T, b: T) => boolean) {
    this.less = less;
  }
  get size(): number {
    return this.data.length;
  }
  peek(): T | undefined {
    return this.data[0];
  }
  push(x: T): void {
    const d = this.data;
    d.push(x);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(d[i], d[p])) break;
      [d[i], d[p]] = [d[p], d[i]];
      i = p;
    }
  }
  pop(): T | undefined {
    const d = this.data;
    if (d.length === 0) return undefined;
    const top = d[0];
    const last = d.pop()!;
    if (d.length > 0) {
      d[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < d.length && this.less(d[l], d[m])) m = l;
        if (r < d.length && this.less(d[r], d[m])) m = r;
        if (m === i) break;
        [d[i], d[m]] = [d[m], d[i]];
        i = m;
      }
    }
    return top;
  }
}


function mergeKLists(lists: number[][]): number[] {
  // Heap entries: [value, listIndex, elementIndex]
  const heap = new MinHeap<[number, number, number]>((a, b) => a[0] < b[0]);
  lists.forEach((list, i) => {
    if (list.length > 0) heap.push([list[0], i, 0]);
  });
  const result: number[] = [];
  while (heap.size > 0) {
    const [val, li, ei] = heap.pop()!;
    result.push(val);
    if (ei + 1 < lists[li].length) heap.push([lists[li][ei + 1], li, ei + 1]);
  }
  return result;
}
```

**Why it works.** Keep one "head" per list in a min-heap; repeatedly pop the smallest and push the next element from the same list. With N total elements, that is O(N log k) time and O(k) heap space (plus the output). Brute force concatenates and sorts (O(N log N)), and merging lists one by one into an accumulator is O(N * k). Divide and conquer (merge pairs of lists, like merge sort) also achieves O(N log k). Trap: skipping empty lists before pushing their first element.

**Say it.** I put the first element of each list in a min-heap, then pop the smallest, append it, and push the next element from that same list, so it's O(N log k) for N total elements.

**Follow-up.** Q: Can you do it without a heap? A: Divide and conquer: merge lists in pairs (0+1, 2+3, ...), then merge the results, repeating until one list remains. Each round touches N elements and there are log k rounds: O(N log k), O(1) extra space for real linked lists.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(mergeKLists([[1, 4, 5], [1, 3, 4], [2, 6]]), [1, 1, 2, 3, 4, 4, 5, 6]);
assert.deepEqual(mergeKLists([]), []);
assert.deepEqual(mergeKLists([[]]), []);
assert.deepEqual(mergeKLists([[], [-1, 5], [], [0]]), [-1, 0, 5]);
assert.deepEqual(mergeKLists([[2], [1]]), [1, 2]);
```

</details>

</details>

---

<a id="algo-064"></a>
### algo-064. Find Median from Data Stream

*Heap / two heaps · Hard*

Design a `MedianFinder` class:
- `addNum(num)` adds an integer from the stream.
- `findMedian()` returns the median of all numbers so far (the mean of the two middle values when the count is even).

```
addNum(1); addNum(2); findMedian() -> 1.5
addNum(3);            findMedian() -> 2
```
`addNum` should be faster than O(n).

**Starter**

```ts
class MedianFinder {
  addNum(num: number): void {
    // TODO
  }
  findMedian(): number {
    // TODO
    return 0;
  }
}
```

<details>
<summary>Solution</summary>

```ts
// Minimal binary min-heap ordered by a comparator.
class MinHeap<T> {
  private data: T[] = [];
  private less: (a: T, b: T) => boolean;
  constructor(less: (a: T, b: T) => boolean) {
    this.less = less;
  }
  get size(): number {
    return this.data.length;
  }
  peek(): T | undefined {
    return this.data[0];
  }
  push(x: T): void {
    const d = this.data;
    d.push(x);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(d[i], d[p])) break;
      [d[i], d[p]] = [d[p], d[i]];
      i = p;
    }
  }
  pop(): T | undefined {
    const d = this.data;
    if (d.length === 0) return undefined;
    const top = d[0];
    const last = d.pop()!;
    if (d.length > 0) {
      d[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < d.length && this.less(d[l], d[m])) m = l;
        if (r < d.length && this.less(d[r], d[m])) m = r;
        if (m === i) break;
        [d[i], d[m]] = [d[m], d[i]];
        i = m;
      }
    }
    return top;
  }
}


class MedianFinder {
  // low: max-heap with the smaller half; high: min-heap with the larger half.
  private low = new MinHeap<number>((a, b) => a > b);
  private high = new MinHeap<number>((a, b) => a < b);

  addNum(num: number): void {
    this.low.push(num);
    this.high.push(this.low.pop()!); // move the largest of the low half up
    if (this.high.size > this.low.size) this.low.push(this.high.pop()!);
  }

  findMedian(): number {
    if (this.low.size === 0) throw new Error('no numbers yet');
    if (this.low.size > this.high.size) return this.low.peek()!;
    return (this.low.peek()! + this.high.peek()!) / 2;
  }
}
```

**Why it works.** Keep the smaller half in a max-heap and the larger half in a min-heap, balanced so `low` has the same size as `high` or one more. The median is then the top of `low` or the average of both tops. Each `addNum` is O(log n), `findMedian` is O(1), space O(n). Brute force (insert into a sorted array) costs O(n) per insert because of shifting. Trap: pushing straight into one heap without routing through the other breaks the "every low <= every high" invariant.

**Say it.** I keep two heaps: a max-heap for the lower half and a min-heap for the upper half, rebalanced after every insert, so the median is always at the tops. O(log n) add, O(1) median.

**Follow-up.** Q: What if all numbers are integers in the range 0..100? A: Keep a count array of 101 buckets plus a total; add is O(1) and the median is found by scanning the buckets, which is O(101) = O(1).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const mf = new MedianFinder();
assert.throws(() => mf.findMedian());
mf.addNum(1);
mf.addNum(2);
assert.equal(mf.findMedian(), 1.5);
mf.addNum(3);
assert.equal(mf.findMedian(), 2);
const m2 = new MedianFinder();
for (const n of [5, 15, 1, 3, 8, 7, 9, 10]) m2.addNum(n);
assert.equal(m2.findMedian(), 7.5); // sorted: 1 3 5 7 8 9 10 15
m2.addNum(-100);
assert.equal(m2.findMedian(), 7);
```

</details>

</details>

---

<a id="algo-065"></a>
### algo-065. Task Scheduler

*Greedy + heap · Medium*

Given an array of CPU `tasks` (letters `A`-`Z`) and a cooldown `n`, each unit of time the CPU runs one task or stays idle. Two runs of the **same** task must be at least `n` intervals apart. Return the minimum number of intervals needed to finish all tasks.

- `tasks = ["A","A","A","B","B","B"], n = 2` -> `8` (A B idle A B idle A B)
- `tasks = ["A","C","A","B","D","B"], n = 1` -> `6`
- `tasks = ["A","A","A","B","B","B"], n = 0` -> `6`

**Starter**

```ts
function leastInterval(tasks: string[], n: number): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function leastInterval(tasks: string[], n: number): number {
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t, (counts.get(t) ?? 0) + 1);
  const maxCount = Math.max(...counts.values());
  let tasksWithMax = 0;
  for (const c of counts.values()) if (c === maxCount) tasksWithMax++;
  // (maxCount - 1) full frames of size n + 1, plus a last frame with the most frequent tasks.
  const framed = (maxCount - 1) * (n + 1) + tasksWithMax;
  return Math.max(tasks.length, framed);
}
```

**Why it works.** The most frequent task dictates the shape: it needs `maxCount - 1` gaps of `n` slots between its runs, giving `(maxCount - 1) * (n + 1)` slots plus one final slot for each task that ties for the max count. If there are enough other tasks to fill every gap, there is no idle time and the answer is just `tasks.length`, hence the `max`. O(N) time, O(1) space (26 letters). The simulation alternative (max-heap of counts plus a cooldown queue) is O(N log 26) and also accepted. Trap: forgetting the `tasks.length` lower bound.

**Say it.** The most frequent task forces (maxCount minus one) frames of size n plus one, plus a last slot for each task tied at max; the answer is that or the number of tasks, whichever is larger. O(N) time.

**Follow-up.** Q: How would you actually produce the schedule? A: Simulate: a max-heap of remaining counts and a queue of (count, readyTime) for tasks on cooldown. Each tick pop the most frequent ready task, run it, and push it to the cooldown queue; move ready tasks back into the heap. Idle when the heap is empty.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(leastInterval(['A', 'A', 'A', 'B', 'B', 'B'], 2), 8);
assert.equal(leastInterval(['A', 'C', 'A', 'B', 'D', 'B'], 1), 6);
assert.equal(leastInterval(['A', 'A', 'A', 'B', 'B', 'B'], 0), 6);
assert.equal(leastInterval(['A', 'A', 'A', 'A', 'A', 'A', 'B', 'C', 'D', 'E', 'F', 'G'], 2), 16);
assert.equal(leastInterval(['A'], 5), 1);
```

</details>

</details>

---

<a id="algo-066"></a>
### algo-066. Number of Islands

*Graphs (grid DFS/BFS) · Medium*

Given an `m x n` grid of `'1'` (land) and `'0'` (water), return the number of islands. An island is land connected horizontally or vertically.

```
[["1","1","0","0"],
 ["1","0","0","1"],
 ["0","0","1","1"]]  -> 2
```
An all-water grid -> `0`.

**Starter**

```ts
function numIslands(grid: string[][]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function numIslands(grid: string[][]): number {
  const rows = grid.length;
  const cols = rows ? grid[0].length : 0;
  const seen = grid.map((row) => row.map(() => false));
  let islands = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== '1' || seen[r][c]) continue;
      islands++;
      // Iterative DFS flood fill (avoids recursion depth limits on big grids).
      const stack: [number, number][] = [[r, c]];
      seen[r][c] = true;
      while (stack.length > 0) {
        const [i, j] = stack.pop()!;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= rows || nj >= cols) continue;
          if (grid[ni][nj] !== '1' || seen[ni][nj]) continue;
          seen[ni][nj] = true;
          stack.push([ni, nj]);
        }
      }
    }
  }
  return islands;
}
```

**Why it works.** Scan every cell; each unvisited land cell starts a new island, and a flood fill (DFS or BFS) marks all land connected to it so it is not counted again. Every cell is visited a constant number of times: O(m * n) time, O(m * n) space for the visited grid / stack. Mark cells as visited when you push them, not when you pop, or the same cell gets pushed many times. Union-find is an alternative, useful when land is added incrementally.

**Say it.** I scan the grid and every time I hit unvisited land I count an island and flood-fill it so its cells aren't counted again. O(m times n) time and space.

**Follow-up.** Q: Land cells are added one at a time and you must report the island count after each addition. A: Union-find: each new land cell is a new set (+1), then union with up to 4 land neighbours, decrementing the count on each successful union. Nearly O(1) amortized per addition (Number of Islands II).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(numIslands([['1', '1', '0', '0'], ['1', '0', '0', '1'], ['0', '0', '1', '1']]), 2);
assert.equal(numIslands([['1', '1', '1', '1', '0'], ['1', '1', '0', '1', '0'], ['1', '1', '0', '0', '0'], ['0', '0', '0', '0', '0']]), 1);
assert.equal(numIslands([['1', '1', '0', '0', '0'], ['1', '1', '0', '0', '0'], ['0', '0', '1', '0', '0'], ['0', '0', '0', '1', '1']]), 3);
assert.equal(numIslands([['0', '0'], ['0', '0']]), 0);
assert.equal(numIslands([]), 0);
assert.equal(numIslands([['1', '0', '1', '0', '1']]), 3);
```

</details>

</details>

---

<a id="algo-067"></a>
### algo-067. Max Area of Island

*Graphs (grid DFS/BFS) · Medium*

Given an `m x n` binary grid (`1` = land, `0` = water), return the area (number of cells) of the largest island, where land connects 4-directionally. Return `0` if there is no land.

```
[[0,1,1,0],
 [0,1,0,0],
 [1,0,1,1]]  -> 3
```

**Starter**

```ts
function maxAreaOfIsland(grid: number[][]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function maxAreaOfIsland(grid: number[][]): number {
  const rows = grid.length;
  const cols = rows ? grid[0].length : 0;
  const seen = grid.map((row) => row.map(() => false));
  let best = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== 1 || seen[r][c]) continue;
      let area = 0;
      const stack: [number, number][] = [[r, c]];
      seen[r][c] = true;
      while (stack.length > 0) {
        const [i, j] = stack.pop()!;
        area++;
        for (const [ni, nj] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
          if (ni < 0 || nj < 0 || ni >= rows || nj >= cols) continue;
          if (grid[ni][nj] !== 1 || seen[ni][nj]) continue;
          seen[ni][nj] = true;
          stack.push([ni, nj]);
        }
      }
      best = Math.max(best, area);
    }
  }
  return best;
}
```

**Why it works.** Same flood fill as Number of Islands, but count the cells popped during each fill and keep the maximum. Each cell is visited once: O(m * n) time and space. Trap: marking cells visited only when popped double-counts cells reachable from two neighbours; mark on push.

**Say it.** I flood-fill each unvisited island with an iterative DFS, counting cells as I go, and keep the largest count. O(m times n) time and space.

**Follow-up.** Q: You may flip one 0 to 1; what's the largest island you can make? A: Label every island with an id and store its area, then for each 0 sum the areas of the distinct island ids among its 4 neighbours plus 1. O(m * n) (Making A Large Island).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(maxAreaOfIsland([[0, 1, 1, 0], [0, 1, 0, 0], [1, 0, 1, 1]]), 3);
assert.equal(maxAreaOfIsland([[0, 0, 0, 0]]), 0);
assert.equal(maxAreaOfIsland([[1, 1], [1, 1]]), 4);
assert.equal(maxAreaOfIsland([[1, 0, 1], [0, 1, 0], [1, 0, 1]]), 1);
assert.equal(maxAreaOfIsland([]), 0);
```

</details>

</details>

---

<a id="algo-068"></a>
### algo-068. Clone Graph

*Graphs (DFS + hash map) · Medium*

Given a reference to a node in a connected undirected graph, return a **deep copy** of the graph. Each node has a `val` and a list of `neighbors`.

Example: adjacency list `[[2,4],[1,3],[2,4],[1,3]]` (node 1 is connected to 2 and 4, etc.) -> a new graph with the same structure where no node is shared with the original. `null` -> `null`.

**Starter**

```ts
class GraphNode {
  val: number;
  neighbors: GraphNode[];
  constructor(val: number, neighbors: GraphNode[] = []) {
    this.val = val;
    this.neighbors = neighbors;
  }
}

function cloneGraph(node: GraphNode | null): GraphNode | null {
  // TODO
  return null;
}
```

<details>
<summary>Solution</summary>

```ts
class GraphNode {
  val: number;
  neighbors: GraphNode[];
  constructor(val: number, neighbors: GraphNode[] = []) {
    this.val = val;
    this.neighbors = neighbors;
  }
}

function cloneGraph(node: GraphNode | null): GraphNode | null {
  if (node === null) return null;
  const copies = new Map<GraphNode, GraphNode>();
  const clone = (orig: GraphNode): GraphNode => {
    const existing = copies.get(orig);
    if (existing) return existing;
    const copy = new GraphNode(orig.val);
    copies.set(orig, copy); // register before recursing so cycles terminate
    for (const nb of orig.neighbors) copy.neighbors.push(clone(nb));
    return copy;
  };
  return clone(node);
}

// Helpers: build a graph from a 1-indexed adjacency list, and read it back.
function buildGraph(adj: number[][]): GraphNode | null {
  if (adj.length === 0) return null;
  const nodes = adj.map((_, i) => new GraphNode(i + 1));
  adj.forEach((nbs, i) => {
    nodes[i].neighbors = nbs.map((v) => nodes[v - 1]);
  });
  return nodes[0];
}

function toAdjacency(start: GraphNode | null): number[][] {
  if (start === null) return [];
  const all = new Map<number, GraphNode>();
  const stack = [start];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (all.has(n.val)) continue;
    all.set(n.val, n);
    stack.push(...n.neighbors);
  }
  return [...all.keys()].sort((a, b) => a - b).map((v) => all.get(v)!.neighbors.map((nb) => nb.val));
}
```

**Why it works.** Traverse the graph (DFS or BFS) while keeping a map from each original node to its copy. When you meet a node that is already in the map, reuse its copy; this both preserves shared structure and stops infinite loops on cycles. O(V + E) time, O(V) space for the map and recursion. Trap: inserting the copy into the map after cloning the neighbours, which recurses forever on a cycle.

**Say it.** I DFS the graph with a map from original node to clone; I create and register the clone before visiting neighbours, so cycles just return the existing copy. O(V plus E) time, O(V) space.

**Follow-up.** Q: How would you deep-copy a linked list with random pointers? A: Same idea: a map from original node to copy, first pass creates copies, second pass wires `next` and `random` through the map. An O(1)-space variant interleaves copies between original nodes.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const adj = [[2, 4], [1, 3], [2, 4], [1, 3]];
const original = buildGraph(adj)!;
const copy = cloneGraph(original)!;
assert.notEqual(copy, original);
assert.deepEqual(toAdjacency(copy), adj);
assert.notEqual(copy.neighbors[0], original.neighbors[0]);
assert.equal(copy.neighbors[0].neighbors[0], copy); // cycle points back to the clone
assert.equal(cloneGraph(null), null);
assert.deepEqual(toAdjacency(cloneGraph(buildGraph([[]]))), [[]]);
```

</details>

</details>

---

<a id="algo-069"></a>
### algo-069. Course Schedule

*Graphs (topological sort) · Medium*

There are `numCourses` courses labeled `0..numCourses-1`. `prerequisites[i] = [a, b]` means you must take `b` before `a`. Return `true` if it is possible to finish all courses.

- `numCourses = 2, prerequisites = [[1,0]]` -> `true`
- `numCourses = 2, prerequisites = [[1,0],[0,1]]` -> `false` (cycle)

**Starter**

```ts
function canFinish(numCourses: number, prerequisites: number[][]): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
function canFinish(numCourses: number, prerequisites: number[][]): boolean {
  const graph: number[][] = Array.from({ length: numCourses }, () => []);
  const indegree = new Array<number>(numCourses).fill(0);
  for (const [course, pre] of prerequisites) {
    graph[pre].push(course);
    indegree[course]++;
  }
  // Kahn's algorithm: repeatedly take courses with no remaining prerequisites.
  const queue: number[] = [];
  for (let i = 0; i < numCourses; i++) if (indegree[i] === 0) queue.push(i);
  let taken = 0;
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head];
    taken++;
    for (const next of graph[c]) {
      if (--indegree[next] === 0) queue.push(next);
    }
  }
  return taken === numCourses;
}
```

**Why it works.** Courses are nodes and prerequisites are directed edges; all courses can be finished exactly when the graph has no cycle. Kahn's algorithm repeatedly removes nodes with in-degree 0; if a cycle exists, its nodes never reach in-degree 0, so fewer than `numCourses` get processed. O(V + E) time and space. The alternative is DFS with three colours (unvisited / visiting / done), where reaching a "visiting" node means a cycle. Trap: getting the edge direction backwards is harmless for cycle detection but breaks the ordering in Course Schedule II.

**Say it.** I build a directed graph and run Kahn's topological sort: start with courses that have no prerequisites, peel them off, and if I can't process every course there must be a cycle. O(V plus E).

**Follow-up.** Q: How would you detect the cycle with DFS instead? A: Colour nodes: 0 = unvisited, 1 = on the current DFS path, 2 = finished. If DFS reaches a node coloured 1, there is a back edge, i.e. a cycle. O(V + E).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(canFinish(2, [[1, 0]]), true);
assert.equal(canFinish(2, [[1, 0], [0, 1]]), false);
assert.equal(canFinish(1, []), true);
assert.equal(canFinish(4, [[1, 0], [2, 1], [3, 2], [1, 3]]), false);
assert.equal(canFinish(5, [[1, 0], [2, 0], [3, 1], [3, 2], [4, 3]]), true);
assert.equal(canFinish(3, [[0, 0]]), false);
```

</details>

</details>

---

<a id="algo-070"></a>
### algo-070. Course Schedule II

*Graphs (topological sort) · Medium*

Same setup as Course Schedule: `numCourses` courses and `prerequisites[i] = [a, b]` meaning `b` must come before `a`. Return **an** order in which you can take all courses, or `[]` if it is impossible.

- `numCourses = 2, prerequisites = [[1,0]]` -> `[0,1]`
- `numCourses = 4, prerequisites = [[1,0],[2,0],[3,1],[3,2]]` -> `[0,1,2,3]` or `[0,2,1,3]`
- `numCourses = 2, prerequisites = [[0,1],[1,0]]` -> `[]`

**Starter**

```ts
function findOrder(numCourses: number, prerequisites: number[][]): number[] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
function findOrder(numCourses: number, prerequisites: number[][]): number[] {
  const graph: number[][] = Array.from({ length: numCourses }, () => []);
  const indegree = new Array<number>(numCourses).fill(0);
  for (const [course, pre] of prerequisites) {
    graph[pre].push(course);
    indegree[course]++;
  }
  const order: number[] = [];
  for (let i = 0; i < numCourses; i++) if (indegree[i] === 0) order.push(i);
  // `order` doubles as the BFS queue.
  for (let head = 0; head < order.length; head++) {
    for (const next of graph[order[head]]) {
      if (--indegree[next] === 0) order.push(next);
    }
  }
  return order.length === numCourses ? order : [];
}
```

**Why it works.** Kahn's topological sort: the order in which zero-in-degree nodes are dequeued is a valid course order. If some nodes never reach in-degree 0 there is a cycle and you return `[]`. O(V + E) time and space. DFS alternative: append each node after all its dependents finish (post-order) and reverse the list, while using colours to detect cycles. Trap: edges must point from prerequisite to course (`pre -> course`), or the order comes out reversed.

**Say it.** I run Kahn's algorithm with edges from prerequisite to course; the dequeue order is the answer, and if it doesn't include every course there's a cycle so I return empty. O(V plus E).

**Follow-up.** Q: Courses with no dependency between them can be taken in the same semester. What is the minimum number of semesters? A: Run Kahn's level by level (BFS layers); the number of layers is the answer, or -1 if a cycle prevents finishing.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
function isValidOrder(n: number, pre: number[][], order: number[]): boolean {
  if (order.length !== n) return false;
  const pos = new Map(order.map((c, i) => [c, i] as [number, number]));
  return pre.every(([a, b]) => pos.get(b)! < pos.get(a)!);
}
assert.deepEqual(findOrder(2, [[1, 0]]), [0, 1]);
const p2 = [[1, 0], [2, 0], [3, 1], [3, 2]];
assert.ok(isValidOrder(4, p2, findOrder(4, p2)));
assert.deepEqual(findOrder(2, [[0, 1], [1, 0]]), []);
assert.deepEqual(findOrder(1, []), [0]);
const p3 = [[0, 3], [3, 1], [1, 2]];
assert.deepEqual(findOrder(4, p3), [2, 1, 3, 0]);
```

</details>

</details>

---

<a id="algo-071"></a>
### algo-071. Rotting Oranges

*Graphs (multi-source BFS) · Medium*

In a grid, `0` is empty, `1` is a fresh orange and `2` is a rotten orange. Every minute, each fresh orange 4-directionally adjacent to a rotten one becomes rotten. Return the minimum number of minutes until no fresh orange remains, or `-1` if that is impossible.

- `[[2,1,1],[1,1,0],[0,1,1]]` -> `4`
- `[[2,1,1],[0,1,1],[1,0,1]]` -> `-1` (bottom-left is unreachable)
- `[[0,2]]` -> `0`

**Starter**

```ts
function orangesRotting(grid: number[][]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function orangesRotting(grid: number[][]): number {
  const rows = grid.length;
  const cols = rows ? grid[0].length : 0;
  const g = grid.map((row) => [...row]); // don't mutate the input
  let queue: [number, number][] = [];
  let fresh = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (g[r][c] === 2) queue.push([r, c]);
      else if (g[r][c] === 1) fresh++;
    }
  }
  let minutes = 0;
  // All rotten oranges start in the queue together: one BFS layer = one minute.
  while (queue.length > 0 && fresh > 0) {
    const next: [number, number][] = [];
    for (const [r, c] of queue) {
      for (const [nr, nc] of [[r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]]) {
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols || g[nr][nc] !== 1) continue;
        g[nr][nc] = 2;
        fresh--;
        next.push([nr, nc]);
      }
    }
    queue = next;
    minutes++;
  }
  return fresh === 0 ? minutes : -1;
}
```

**Why it works.** Multi-source BFS: put every initially rotten orange in the queue at time 0 and expand layer by layer; each layer is one minute. Running a separate BFS from each rotten orange (or simulating minute by minute over the whole grid) is O((m * n)^2); a single multi-source BFS is O(m * n) time and space. Count fresh oranges up front so you can return `-1` if some stay fresh. Trap: incrementing minutes after the last layer even when nothing rotted, which is avoided by looping only while `fresh > 0`.

**Say it.** This is multi-source BFS: I seed the queue with all rotten oranges, spread one layer per minute, and track the fresh count so I can return minus one if any are unreachable. O(m times n).

**Follow-up.** Q: Given a grid of walls, gates and empty rooms, fill each room with the distance to its nearest gate. A: Same multi-source BFS seeded from all gates at once; the first time BFS reaches a room is its shortest distance (Walls and Gates). O(m * n).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(orangesRotting([[2, 1, 1], [1, 1, 0], [0, 1, 1]]), 4);
assert.equal(orangesRotting([[2, 1, 1], [0, 1, 1], [1, 0, 1]]), -1);
assert.equal(orangesRotting([[0, 2]]), 0);
assert.equal(orangesRotting([[0]]), 0);
assert.equal(orangesRotting([[1]]), -1);
assert.equal(orangesRotting([[2, 1, 1, 1, 2]]), 2);
```

</details>

</details>

---

<a id="algo-072"></a>
### algo-072. Network Delay Time

*Graphs (Dijkstra) · Medium*

You have `n` nodes labeled `1..n` and directed weighted edges `times[i] = [u, v, w]` (a signal takes `w` time from `u` to `v`). A signal is sent from node `k`. Return the time it takes for **all** nodes to receive it, or `-1` if some node is unreachable.

- `times = [[2,1,1],[2,3,1],[3,4,1]], n = 4, k = 2` -> `2`
- `times = [[1,2,1]], n = 2, k = 2` -> `-1`

**Starter**

```ts
function networkDelayTime(times: number[][], n: number, k: number): number {
  // TODO
  return -1;
}
```

<details>
<summary>Solution</summary>

```ts
// Minimal binary min-heap ordered by a comparator.
class MinHeap<T> {
  private data: T[] = [];
  private less: (a: T, b: T) => boolean;
  constructor(less: (a: T, b: T) => boolean) {
    this.less = less;
  }
  get size(): number {
    return this.data.length;
  }
  peek(): T | undefined {
    return this.data[0];
  }
  push(x: T): void {
    const d = this.data;
    d.push(x);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(d[i], d[p])) break;
      [d[i], d[p]] = [d[p], d[i]];
      i = p;
    }
  }
  pop(): T | undefined {
    const d = this.data;
    if (d.length === 0) return undefined;
    const top = d[0];
    const last = d.pop()!;
    if (d.length > 0) {
      d[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < d.length && this.less(d[l], d[m])) m = l;
        if (r < d.length && this.less(d[r], d[m])) m = r;
        if (m === i) break;
        [d[i], d[m]] = [d[m], d[i]];
        i = m;
      }
    }
    return top;
  }
}


function networkDelayTime(times: number[][], n: number, k: number): number {
  const graph = new Map<number, [number, number][]>();
  for (const [u, v, w] of times) {
    if (!graph.has(u)) graph.set(u, []);
    graph.get(u)!.push([v, w]);
  }
  const dist = new Map<number, number>();
  const heap = new MinHeap<[number, number]>((a, b) => a[0] < b[0]); // [distance, node]
  heap.push([0, k]);
  while (heap.size > 0) {
    const [d, node] = heap.pop()!;
    if (dist.has(node)) continue; // already finalized with a shorter distance
    dist.set(node, d);
    for (const [next, w] of graph.get(node) ?? []) {
      if (!dist.has(next)) heap.push([d + w, next]);
    }
  }
  if (dist.size < n) return -1;
  return Math.max(...dist.values());
}
```

**Why it works.** Single-source shortest paths with non-negative weights is Dijkstra: always finalize the unvisited node with the smallest tentative distance, using a min-heap. The answer is the largest shortest-path distance, or `-1` if some node was never reached. With a heap it is O(E log E) time and O(V + E) space; Bellman-Ford is O(V * E) and only needed for negative weights. Trap: plain BFS is wrong here because edges have different weights; also skip stale heap entries for nodes already finalized.

**Say it.** It's single-source shortest path with non-negative weights, so I run Dijkstra with a min-heap and return the maximum of the final distances, or minus one if a node is unreachable. O(E log E).

**Follow-up.** Q: What if some edge weights are negative? A: Dijkstra's greedy finalization is no longer valid. Use Bellman-Ford: relax all edges V - 1 times, O(V * E); a further successful relaxation means a negative cycle.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(networkDelayTime([[2, 1, 1], [2, 3, 1], [3, 4, 1]], 4, 2), 2);
assert.equal(networkDelayTime([[1, 2, 1]], 2, 1), 1);
assert.equal(networkDelayTime([[1, 2, 1]], 2, 2), -1);
assert.equal(networkDelayTime([[1, 2, 5], [1, 3, 1], [3, 2, 1]], 3, 1), 2); // indirect path is shorter
assert.equal(networkDelayTime([], 1, 1), 0);
```

</details>

</details>

---

<a id="algo-073"></a>
### algo-073. Number of Connected Components in an Undirected Graph

*Graphs (union-find) · Medium*

You have `n` nodes labeled `0..n-1` and a list of undirected `edges`. Return the number of connected components.

- `n = 5, edges = [[0,1],[1,2],[3,4]]` -> `2`
- `n = 5, edges = [[0,1],[1,2],[2,3],[3,4]]` -> `1`
- `n = 3, edges = []` -> `3`

**Starter**

```ts
function countComponents(n: number, edges: number[][]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function countComponents(n: number, edges: number[][]): number {
  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = new Array<number>(n).fill(0);

  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path halving
      x = parent[x];
    }
    return x;
  };

  let components = n;
  for (const [a, b] of edges) {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) continue;
    if (rank[ra] < rank[rb]) [ra, rb] = [rb, ra];
    parent[rb] = ra; // union by rank
    if (rank[ra] === rank[rb]) rank[ra]++;
    components--;
  }
  return components;
}
```

**Why it works.** Start with `n` components and union the endpoints of every edge; each union that merges two different roots reduces the count by one. With path compression (here path halving) and union by rank, each operation is nearly O(1) (inverse Ackermann), so the total is O(n + E * alpha(n)) time and O(n) space. DFS/BFS over an adjacency list is also O(n + E) and equally accepted. Trap: decrementing the count for edges whose endpoints are already connected.

**Say it.** I use union-find: start with n components and for each edge union the two roots, decrementing the count only when they were different. With path compression and union by rank it's nearly linear.

**Follow-up.** Q: How do you check whether these edges form a valid tree? A: A tree has exactly n - 1 edges and is connected (equivalently: no union ever finds both endpoints already in the same set). So check `edges.length === n - 1` and that union-find never sees a cycle (Graph Valid Tree).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(countComponents(5, [[0, 1], [1, 2], [3, 4]]), 2);
assert.equal(countComponents(5, [[0, 1], [1, 2], [2, 3], [3, 4]]), 1);
assert.equal(countComponents(3, []), 3);
assert.equal(countComponents(4, [[0, 1], [1, 0], [2, 3], [3, 2], [0, 1]]), 2);
assert.equal(countComponents(6, [[0, 1], [1, 2], [2, 0], [3, 4]]), 3);
```

</details>

</details>

---

<a id="algo-074"></a>
### algo-074. Word Ladder

*Graphs (BFS shortest path) · Hard*

Given `beginWord`, `endWord` and a `wordList`, return the number of words in the shortest transformation sequence from `beginWord` to `endWord`, where each step changes exactly one letter and every intermediate word (and `endWord`) must be in `wordList`. Return `0` if no sequence exists.

- `begin = "hit", end = "cog", list = ["hot","dot","dog","lot","log","cog"]` -> `5` (hit -> hot -> dot -> dog -> cog)
- same, but list without `"cog"` -> `0`

**Starter**

```ts
function ladderLength(beginWord: string, endWord: string, wordList: string[]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function ladderLength(beginWord: string, endWord: string, wordList: string[]): number {
  const words = new Set(wordList);
  if (!words.has(endWord)) return 0;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let level: string[] = [beginWord];
  words.delete(beginWord);
  let steps = 1;
  while (level.length > 0) {
    const next: string[] = [];
    for (const word of level) {
      if (word === endWord) return steps;
      for (let i = 0; i < word.length; i++) {
        for (const ch of alphabet) {
          if (ch === word[i]) continue;
          const candidate = word.slice(0, i) + ch + word.slice(i + 1);
          if (words.has(candidate)) {
            words.delete(candidate); // mark visited
            next.push(candidate);
          }
        }
      }
    }
    level = next;
    steps++;
  }
  return 0;
}
```

**Why it works.** Words are nodes and one-letter differences are edges; the shortest sequence in an unweighted graph is found with BFS. Comparing every pair of words to build edges is O(N^2 * L); instead, generate the 26 * L neighbours of each word and look them up in a set, giving O(N * L * 26 * L) time (the extra L is for building strings) and O(N * L) space. Delete words from the set when enqueued so each is visited once. Trap: the answer counts words, not edges, so start at 1; and return 0 early if `endWord` is not in the list.

**Say it.** I treat it as an unweighted graph and BFS from the start word, generating neighbours by changing each letter to a through z and checking a set, removing words as I visit them. Roughly O(N times L squared times 26).

**Follow-up.** Q: How can you speed it up? A: Bidirectional BFS: expand from both ends and always grow the smaller frontier; stop when they meet. This cuts the explored search space roughly to the square root. Precomputing wildcard patterns (`h*t -> [hot, hit]`) is another common optimization.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(ladderLength('hit', 'cog', ['hot', 'dot', 'dog', 'lot', 'log', 'cog']), 5);
assert.equal(ladderLength('hit', 'cog', ['hot', 'dot', 'dog', 'lot', 'log']), 0);
assert.equal(ladderLength('a', 'c', ['a', 'b', 'c']), 2);
assert.equal(ladderLength('hot', 'dog', ['hot', 'dog']), 0);
assert.equal(ladderLength('red', 'tax', ['ted', 'tex', 'red', 'tax', 'tad', 'den', 'rex', 'pee']), 4);
```

</details>

</details>

---

<a id="algo-075"></a>
### algo-075. Subsets

*Backtracking · Medium*

Given an array `nums` of **unique** integers, return all possible subsets (the power set). No duplicate subsets; any order.

- `[1,2,3]` -> `[[],[1],[1,2],[1,2,3],[1,3],[2],[2,3],[3]]`
- `[0]` -> `[[],[0]]`

**Starter**

```ts
function subsets(nums: number[]): number[][] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
function subsets(nums: number[]): number[][] {
  const result: number[][] = [];
  const current: number[] = [];
  const backtrack = (start: number): void => {
    result.push([...current]); // every node of the recursion tree is a subset
    for (let i = start; i < nums.length; i++) {
      current.push(nums[i]);
      backtrack(i + 1);
      current.pop();
    }
  };
  backtrack(0);
  return result;
}
```

**Why it works.** Backtracking: at each call record the current subset, then try adding each later element and recurse, undoing the choice afterwards. Starting the loop at `start` means each subset is built in index order exactly once. There are 2^n subsets of average length n/2, so O(n * 2^n) time and output; O(n) extra space for the recursion. Trap: pushing `current` itself instead of a copy, so every entry ends up as the same (empty) array. A bitmask loop over `0..2^n - 1` is an iterative alternative.

**Say it.** I backtrack: record the current subset, then for each remaining element add it, recurse from the next index, and remove it. That gives 2 to the n subsets in O(n times 2 to the n) time.

**Follow-up.** Q: What if `nums` contains duplicates? A: Sort first, then in the loop skip `nums[i]` when `i > start && nums[i] === nums[i - 1]`, so the same value is not chosen twice at the same depth (Subsets II).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const norm = (r: number[][]) => r.map((s) => [...s].sort((a, b) => a - b).join(',')).sort();
assert.deepEqual(norm(subsets([1, 2, 3])), norm([[], [1], [2], [1, 2], [3], [1, 3], [2, 3], [1, 2, 3]]));
assert.deepEqual(subsets([0]), [[], [0]]);
assert.deepEqual(subsets([]), [[]]);
assert.equal(subsets([1, 2, 3, 4, 5]).length, 32);
```

</details>

</details>

---

<a id="algo-076"></a>
### algo-076. Permutations

*Backtracking · Medium*

Given an array `nums` of **distinct** integers, return all possible permutations in any order.

- `[1,2,3]` -> `[[1,2,3],[1,3,2],[2,1,3],[2,3,1],[3,1,2],[3,2,1]]`
- `[0,1]` -> `[[0,1],[1,0]]`
- `[1]` -> `[[1]]`

**Starter**

```ts
function permute(nums: number[]): number[][] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
function permute(nums: number[]): number[][] {
  const result: number[][] = [];
  const current: number[] = [];
  const used = new Array<boolean>(nums.length).fill(false);
  const backtrack = (): void => {
    if (current.length === nums.length) {
      result.push([...current]);
      return;
    }
    for (let i = 0; i < nums.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      current.push(nums[i]);
      backtrack();
      current.pop();
      used[i] = false;
    }
  };
  backtrack();
  return result;
}
```

**Why it works.** Build the permutation one position at a time, trying every element not yet used, and undo the choice after recursing. A `used` array makes the "is it taken?" check O(1) instead of `current.includes` (O(n)). There are n! permutations of length n: O(n * n!) time, O(n) extra space besides the output. Trap: forgetting to reset `used[i]` when backtracking.

**Say it.** I backtrack with a used array: at each depth I try every unused number, recurse, then undo. There are n factorial results, so O(n times n factorial) time.

**Follow-up.** Q: What if `nums` has duplicates? A: Sort, then skip `nums[i]` if it equals `nums[i - 1]` and `nums[i - 1]` is not currently used; this ensures equal values are placed in a fixed order, avoiding duplicate permutations (Permutations II).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const key = (r: number[][]) => r.map((p) => p.join(',')).sort();
assert.deepEqual(key(permute([1, 2, 3])), key([[1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1]]));
assert.deepEqual(key(permute([0, 1])), ['0,1', '1,0']);
assert.deepEqual(permute([1]), [[1]]);
assert.equal(new Set(key(permute([1, 2, 3, 4, 5]))).size, 120);
```

</details>

</details>

---

<a id="algo-077"></a>
### algo-077. Combination Sum

*Backtracking · Medium*

Given an array of **distinct** positive integers `candidates` and a `target`, return all unique combinations of candidates that sum to `target`. The same number may be used **any number of times**. Two combinations are the same if they use the same numbers with the same frequencies.

- `candidates = [2,3,6,7], target = 7` -> `[[2,2,3],[7]]`
- `candidates = [2,3,5], target = 8` -> `[[2,2,2,2],[2,3,3],[3,5]]`
- `candidates = [2], target = 1` -> `[]`

**Starter**

```ts
function combinationSum(candidates: number[], target: number): number[][] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
function combinationSum(candidates: number[], target: number): number[][] {
  const sorted = [...candidates].sort((a, b) => a - b);
  const result: number[][] = [];
  const current: number[] = [];
  const backtrack = (start: number, remaining: number): void => {
    if (remaining === 0) {
      result.push([...current]);
      return;
    }
    for (let i = start; i < sorted.length; i++) {
      if (sorted[i] > remaining) break; // sorted, so no later candidate fits either
      current.push(sorted[i]);
      backtrack(i, remaining - sorted[i]); // i, not i + 1: reuse allowed
      current.pop();
    }
  };
  backtrack(0, target);
  return result;
}
```

**Why it works.** Backtrack over candidates in a fixed order, passing the same start index `i` when recursing so a number can be reused but earlier numbers are never revisited; that ordering is what prevents duplicates like `[2,3,2]`. Sorting lets you break the loop as soon as a candidate exceeds the remaining sum. Time is exponential, roughly O(n^(T/m)) where T is the target and m the smallest candidate; space O(T/m) for the recursion depth. Trap: recursing with `i + 1` (forbids reuse) or `0` (produces permutations of the same combination).

**Say it.** I backtrack with a start index, recursing with the same index so a number can repeat, and since the candidates are sorted I stop the loop once a number exceeds what's left. Exponential time, depth bounded by target over the smallest candidate.

**Follow-up.** Q: What if each candidate may be used at most once and the input has duplicates? A: Sort, recurse with `i + 1`, and skip `candidates[i]` when `i > start` and it equals `candidates[i - 1]` (Combination Sum II).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const key = (r: number[][]) => r.map((c) => [...c].sort((a, b) => a - b).join(',')).sort();
assert.deepEqual(key(combinationSum([2, 3, 6, 7], 7)), ['2,2,3', '7']);
assert.deepEqual(key(combinationSum([2, 3, 5], 8)), ['2,2,2,2', '2,3,3', '3,5']);
assert.deepEqual(combinationSum([2], 1), []);
assert.deepEqual(combinationSum([1], 2), [[1, 1]]);
assert.deepEqual(key(combinationSum([7, 3, 2], 7)), ['2,2,3', '7']);
```

</details>

</details>

---

<a id="algo-078"></a>
### algo-078. Generate Parentheses

*Backtracking · Medium*

Given `n` pairs of parentheses, return all combinations of well-formed (balanced) parentheses.

- `n = 3` -> `["((()))","(()())","(())()","()(())","()()()"]`
- `n = 1` -> `["()"]`

**Starter**

```ts
function generateParenthesis(n: number): string[] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
function generateParenthesis(n: number): string[] {
  const result: string[] = [];
  const build = (current: string, open: number, close: number): void => {
    if (current.length === 2 * n) {
      result.push(current);
      return;
    }
    if (open < n) build(current + '(', open + 1, close);
    if (close < open) build(current + ')', open, close + 1); // never close more than opened
  };
  build('', 0, 0);
  return result;
}
```

**Why it works.** Brute force generates all 2^(2n) strings and filters the balanced ones. Backtracking only ever builds valid prefixes: add `(` while fewer than `n` are open, and add `)` only while it would not exceed the number of `(` so far. The number of results is the n-th Catalan number, so time is O(4^n / sqrt(n)) and recursion depth is O(n). Trap: allowing `)` whenever `close < n`, which creates invalid strings like `)(`.

**Say it.** I build the string character by character, adding an open paren while I have some left and a close paren only when there are more opens than closes, so every string I finish is valid. The count is the Catalan number, about 4 to the n over root n.

**Follow-up.** Q: How would you just count them instead of generating? A: The answer is the n-th Catalan number: C(0) = 1 and C(n) = sum over i of C(i) * C(n - 1 - i), an O(n^2) DP (or the closed form (2n)! / ((n + 1)! n!)).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(generateParenthesis(3).sort(), ['((()))', '(()())', '(())()', '()(())', '()()()']);
assert.deepEqual(generateParenthesis(1), ['()']);
assert.equal(generateParenthesis(4).length, 14);
assert.equal(generateParenthesis(5).length, 42);
```

</details>

</details>

---

<a id="algo-079"></a>
### algo-079. Word Search

*Backtracking (grid DFS) · Medium*

Given an `m x n` grid of characters `board` and a string `word`, return `true` if `word` can be formed from letters of sequentially adjacent cells (horizontal or vertical neighbours). A cell may not be used more than once in the same word.

```
board = [["A","B","C","E"],
         ["S","F","C","S"],
         ["A","D","E","E"]]
"ABCCED" -> true, "SEE" -> true, "ABCB" -> false
```

**Starter**

```ts
function exist(board: string[][], word: string): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
function exist(board: string[][], word: string): boolean {
  const rows = board.length;
  const cols = rows ? board[0].length : 0;
  const dfs = (r: number, c: number, i: number): boolean => {
    if (i === word.length) return true;
    if (r < 0 || c < 0 || r >= rows || c >= cols || board[r][c] !== word[i]) return false;
    const saved = board[r][c];
    board[r][c] = '#'; // mark as used on the current path
    const found = dfs(r + 1, c, i + 1) || dfs(r - 1, c, i + 1) || dfs(r, c + 1, i + 1) || dfs(r, c - 1, i + 1);
    board[r][c] = saved; // restore when backtracking
    return found;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (dfs(r, c, 0)) return true;
    }
  }
  return false;
}
```

**Why it works.** Try every cell as a starting point and DFS to neighbours matching the next character, temporarily marking the cell so it cannot be reused on the current path and restoring it on the way back. Worst case O(m * n * 3^L) time (after the first step each cell has at most 3 unvisited directions), O(L) recursion space where L is the word length. Trap: using a global visited set that is never un-marked, which wrongly blocks cells for other paths. Pruning: return false early if the board lacks enough of some letter.

**Say it.** From each cell I DFS along matching letters, marking a cell as used while it's on the current path and restoring it when I backtrack. That's O(m times n times 3 to the L) worst case.

**Follow-up.** Q: Now find all words from a list of 10,000 words in the board. A: Put the words in a trie and do one DFS per cell that walks the trie alongside the board, collecting words when a node marks a word end and pruning branches with no trie child (Word Search II).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const mk = () => [['A', 'B', 'C', 'E'], ['S', 'F', 'C', 'S'], ['A', 'D', 'E', 'E']];
assert.equal(exist(mk(), 'ABCCED'), true);
assert.equal(exist(mk(), 'SEE'), true);
assert.equal(exist(mk(), 'ABCB'), false);
assert.equal(exist([['a']], 'a'), true);
assert.equal(exist([['a', 'a']], 'aaa'), false);
const b = mk();
exist(b, 'ABCCED');
assert.deepEqual(b, mk()); // board restored
```

</details>

</details>

---

<a id="algo-080"></a>
### algo-080. Letter Combinations of a Phone Number

*Backtracking · Medium*

Given a string of digits `2-9`, return all letter combinations the number could represent on a phone keypad (2 = abc, 3 = def, 4 = ghi, 5 = jkl, 6 = mno, 7 = pqrs, 8 = tuv, 9 = wxyz). Any order.

- `"23"` -> `["ad","ae","af","bd","be","bf","cd","ce","cf"]`
- `""` -> `[]`
- `"2"` -> `["a","b","c"]`

**Starter**

```ts
function letterCombinations(digits: string): string[] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
const KEYPAD: Record<string, string> = {
  '2': 'abc', '3': 'def', '4': 'ghi', '5': 'jkl',
  '6': 'mno', '7': 'pqrs', '8': 'tuv', '9': 'wxyz',
};

function letterCombinations(digits: string): string[] {
  if (digits.length === 0) return [];
  const result: string[] = [];
  const build = (i: number, current: string): void => {
    if (i === digits.length) {
      result.push(current);
      return;
    }
    for (const ch of KEYPAD[digits[i]]) build(i + 1, current + ch);
  };
  build(0, '');
  return result;
}
```

**Why it works.** Each digit is one level of the recursion tree, and each letter on that key is a branch; leaves at depth `digits.length` are the answers. With up to 4 letters per key, there are O(4^n) combinations of length n, so O(n * 4^n) time and O(n) recursion depth. Trap: the empty input must return `[]`, not `[""]`. An iterative BFS that extends every partial string by each letter of the next digit works equally well.

**Say it.** I recurse digit by digit and branch on every letter for that key, adding the string when I reach the end; with up to 4 letters per digit that's O(n times 4 to the n).

**Follow-up.** Q: Can you do it iteratively? A: Start with `['']` and for each digit replace the list with every existing prefix extended by each of that digit's letters. Same complexity, no recursion.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(letterCombinations('23').sort(), ['ad', 'ae', 'af', 'bd', 'be', 'bf', 'cd', 'ce', 'cf']);
assert.deepEqual(letterCombinations(''), []);
assert.deepEqual(letterCombinations('2'), ['a', 'b', 'c']);
assert.equal(letterCombinations('79').length, 16);
assert.equal(letterCombinations('234').length, 27);
```

</details>

</details>

---

<a id="algo-081"></a>
### algo-081. Climbing Stairs

*Dynamic programming (1D) · Easy*

You are climbing a staircase with `n` steps. Each time you can climb 1 or 2 steps. In how many distinct ways can you reach the top?

- `n = 2` -> `2` (1+1, 2)
- `n = 3` -> `3` (1+1+1, 1+2, 2+1)
- `n = 5` -> `8`

**Starter**

```ts
function climbStairs(n: number): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function climbStairs(n: number): number {
  // ways(i) = ways(i - 1) + ways(i - 2): a Fibonacci sequence.
  let prev = 1; // ways to reach step 0
  let curr = 1; // ways to reach step 1
  for (let i = 2; i <= n; i++) {
    [prev, curr] = [curr, prev + curr];
  }
  return curr;
}
```

**Why it works.** The last move onto step `n` is either a 1-step from `n - 1` or a 2-step from `n - 2`, so `ways(n) = ways(n - 1) + ways(n - 2)`: Fibonacci. Plain recursion recomputes the same subproblems and is O(2^n); memoization or bottom-up DP is O(n), and since each value only needs the previous two, space drops to O(1). Trap: base cases; `ways(0) = 1` (one way to do nothing) keeps the recurrence clean.

**Say it.** To reach step n you came from n minus 1 or n minus 2, so the count is Fibonacci; I iterate keeping just the last two values, O(n) time and O(1) space.

**Follow-up.** Q: What if you can take any step size from a set like {1, 3, 5}? A: Generalize: `ways[i] = sum of ways[i - s]` for each allowed step s with `i - s >= 0`. O(n * k) time, O(n) space (or O(max step) with a rolling buffer).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(climbStairs(1), 1);
assert.equal(climbStairs(2), 2);
assert.equal(climbStairs(3), 3);
assert.equal(climbStairs(5), 8);
assert.equal(climbStairs(45), 1836311903);
```

</details>

</details>

---

<a id="algo-082"></a>
### algo-082. House Robber

*Dynamic programming (1D) · Medium*

Houses on a street have `nums[i]` money each. You cannot rob two **adjacent** houses (alarms). Return the maximum amount you can rob.

- `[1,2,3,1]` -> `4` (rob houses 0 and 2)
- `[2,7,9,3,1]` -> `12` (2 + 9 + 1)
- `[2,1,1,2]` -> `4`

**Starter**

```ts
function rob(nums: number[]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function rob(nums: number[]): number {
  let skipPrev = 0; // best total up to i - 2
  let takePrev = 0; // best total up to i - 1
  for (const money of nums) {
    // Either skip this house, or rob it on top of the best up to i - 2.
    [skipPrev, takePrev] = [takePrev, Math.max(takePrev, skipPrev + money)];
  }
  return takePrev;
}
```

**Why it works.** Let `best(i)` be the max loot from the first `i` houses: either skip house `i` (`best(i - 1)`) or rob it (`best(i - 2) + nums[i]`). Trying every non-adjacent subset is O(2^n); the DP is O(n) time, and keeping only the last two values gives O(1) space. Trap: greedy choices like "take all even or all odd indexes" fail on `[2,1,1,2]` (answer 4).

**Say it.** At each house I choose the better of skipping it or robbing it plus the best total two houses back; I only keep two rolling values, so O(n) time and O(1) space.

**Follow-up.** Q: Can you also return which houses were robbed? A: Keep the full `dp` array, then walk backwards from the end: if `dp[i] === dp[i - 1]` house i was skipped, otherwise it was robbed and you jump to `i - 2`.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(rob([1, 2, 3, 1]), 4);
assert.equal(rob([2, 7, 9, 3, 1]), 12);
assert.equal(rob([2, 1, 1, 2]), 4);
assert.equal(rob([]), 0);
assert.equal(rob([5]), 5);
```

</details>

</details>

---

<a id="algo-083"></a>
### algo-083. House Robber II

*Dynamic programming (1D) · Medium*

Same as House Robber, but the houses are arranged in a **circle**: the first and last houses are adjacent. Return the maximum amount you can rob without robbing two adjacent houses.

- `[2,3,2]` -> `3`
- `[1,2,3,1]` -> `4`
- `[1,2,3]` -> `3`

**Starter**

```ts
function rob(nums: number[]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function robLine(nums: number[], start: number, end: number): number {
  let skipPrev = 0;
  let takePrev = 0;
  for (let i = start; i <= end; i++) {
    [skipPrev, takePrev] = [takePrev, Math.max(takePrev, skipPrev + nums[i])];
  }
  return takePrev;
}

function rob(nums: number[]): number {
  const n = nums.length;
  if (n === 0) return 0;
  if (n === 1) return nums[0];
  // First and last can't both be robbed: solve without the last, and without the first.
  return Math.max(robLine(nums, 0, n - 2), robLine(nums, 1, n - 1));
}
```

**Why it works.** The circle only adds one constraint: house 0 and house n-1 cannot both be robbed. So the answer is the better of two linear House Robber runs, one on `nums[0..n-2]` and one on `nums[1..n-1]`. O(n) time, O(1) space. Trap: the single-house case, where both ranges would be empty, must return `nums[0]`.

**Say it.** Since the first and last houses can't both be robbed, I run the linear house robber twice, once excluding the last house and once excluding the first, and take the max. O(n) time, O(1) space.

**Follow-up.** Q: What if the houses form a binary tree (a parent and child can't both be robbed)? A: DFS returning a pair `[robThis, skipThis]` for each node: `robThis = val + left.skip + right.skip`, `skipThis = max(left) + max(right)`. O(n) (House Robber III).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(rob([2, 3, 2]), 3);
assert.equal(rob([1, 2, 3, 1]), 4);
assert.equal(rob([1, 2, 3]), 3);
assert.equal(rob([7]), 7);
assert.equal(rob([200, 3, 140, 20, 10]), 340);
```

</details>

</details>

---

<a id="algo-084"></a>
### algo-084. Coin Change

*Dynamic programming (unbounded knapsack) · Medium*

Given coin denominations `coins` (unlimited supply of each) and an `amount`, return the **fewest** coins needed to make that amount, or `-1` if it cannot be made.

- `coins = [1,2,5], amount = 11` -> `3` (5 + 5 + 1)
- `coins = [2], amount = 3` -> `-1`
- `coins = [1], amount = 0` -> `0`

**Starter**

```ts
function coinChange(coins: number[], amount: number): number {
  // TODO
  return -1;
}
```

<details>
<summary>Solution</summary>

```ts
function coinChange(coins: number[], amount: number): number {
  // dp[a] = fewest coins to make amount a.
  const dp = new Array<number>(amount + 1).fill(Infinity);
  dp[0] = 0;
  for (let a = 1; a <= amount; a++) {
    for (const coin of coins) {
      if (coin <= a && dp[a - coin] + 1 < dp[a]) dp[a] = dp[a - coin] + 1;
    }
  }
  return dp[amount] === Infinity ? -1 : dp[amount];
}
```

**Why it works.** Bottom-up DP over amounts: `dp[a] = 1 + min(dp[a - coin])` over all coins that fit, with `dp[0] = 0`. Greedy (always take the biggest coin) fails, e.g. coins `[1,3,4]` and amount 6 gives 4+1+1 instead of 3+3. Plain recursion is exponential; the DP is O(amount * coins) time and O(amount) space. Trap: initialise with Infinity (not 0) and map unreachable results to `-1`.

**Say it.** dp of a is one plus the minimum dp of a minus coin over all coins; I fill it from 0 up to the amount, which is O(amount times number of coins). Greedy doesn't work for arbitrary coin sets.

**Follow-up.** Q: Count the number of ways to make the amount instead. A: `ways[0] = 1`, and loop coins in the outer loop, amounts in the inner: `ways[a] += ways[a - coin]`. Coins outside ensures combinations, not permutations, are counted (Coin Change II).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(coinChange([1, 2, 5], 11), 3);
assert.equal(coinChange([2], 3), -1);
assert.equal(coinChange([1], 0), 0);
assert.equal(coinChange([1, 3, 4], 6), 2); // greedy would give 3
assert.equal(coinChange([186, 419, 83, 408], 6249), 20);
```

</details>

</details>

---

<a id="algo-085"></a>
### algo-085. Longest Increasing Subsequence

*Dynamic programming (LIS / binary search) · Medium*

Given an integer array `nums`, return the length of the longest **strictly increasing** subsequence (elements need not be contiguous).

- `[10,9,2,5,3,7,101,18]` -> `4` (e.g. 2, 3, 7, 101)
- `[0,1,0,3,2,3]` -> `4`
- `[7,7,7,7]` -> `1`

Can you do better than O(n^2)?

**Starter**

```ts
function lengthOfLIS(nums: number[]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function lengthOfLIS(nums: number[]): number {
  // tails[k] = smallest possible tail of an increasing subsequence of length k + 1.
  const tails: number[] = [];
  for (const x of nums) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      // first index with tails[i] >= x
      const mid = (lo + hi) >> 1;
      if (tails[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = x; // extend (lo === length) or improve an existing tail
  }
  return tails.length;
}
```

**Why it works.** The classic DP is `dp[i] = 1 + max(dp[j])` for `j < i` with `nums[j] < nums[i]`: O(n^2) time, O(n) space. The optimal "patience sorting" approach keeps `tails`, where `tails[k]` is the smallest tail of any increasing subsequence of length k + 1; this array is sorted, so each element binary-searches the first tail `>= x` and replaces it (or appends). O(n log n) time, O(n) space. Trap: `tails` is not itself a valid subsequence, only its length is meaningful; and use `>=` (lower bound) for strictly increasing.

**Say it.** I keep an array of the smallest tail for each subsequence length; for each number I binary-search where it goes and either extend or replace, so the array length is the answer. O(n log n).

**Follow-up.** Q: How do you return the actual subsequence? A: Store, for each element, the index it was placed at in `tails` and a parent pointer to the element at `tails[pos - 1]` at that moment; then walk parents back from the last element placed at the final length.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(lengthOfLIS([10, 9, 2, 5, 3, 7, 101, 18]), 4);
assert.equal(lengthOfLIS([0, 1, 0, 3, 2, 3]), 4);
assert.equal(lengthOfLIS([7, 7, 7, 7]), 1);
assert.equal(lengthOfLIS([]), 0);
assert.equal(lengthOfLIS([4, 10, 4, 3, 8, 9]), 3);
assert.equal(lengthOfLIS([1, 2, 3, 4, 5]), 5);
```

</details>

</details>

---

<a id="algo-086"></a>
### algo-086. Longest Common Subsequence

*Dynamic programming (2D) · Medium*

Given two strings `text1` and `text2`, return the length of their longest common subsequence (characters in the same relative order, not necessarily contiguous). Return `0` if none.

- `"abcde", "ace"` -> `3` ("ace")
- `"abc", "abc"` -> `3`
- `"abc", "def"` -> `0`

**Starter**

```ts
function longestCommonSubsequence(text1: string, text2: string): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function longestCommonSubsequence(text1: string, text2: string): number {
  const m = text1.length;
  const n = text2.length;
  // prev/curr are rows of the (m+1) x (n+1) table: dp[i][j] = LCS of text1[0..i) and text2[0..j).
  let prev = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const curr = new Array<number>(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      curr[j] = text1[i - 1] === text2[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}
```

**Why it works.** `dp[i][j]` is the LCS of the first `i` chars of `text1` and the first `j` of `text2`: if the last characters match, extend `dp[i-1][j-1]` by 1; otherwise take the better of dropping a character from either string. Brute force enumerates 2^m subsequences; the DP is O(m * n) time, and since each row only needs the previous one, O(n) space. Trap: off-by-one indexing; the extra row/column of zeros for empty prefixes avoids special cases.

**Say it.** dp of i, j is the LCS of the two prefixes: plus one on a character match, otherwise the max of dropping one character from either side. O(m times n) time, and I keep only two rows so O(n) space.

**Follow-up.** Q: How do you print the actual subsequence? A: Keep the full 2D table, then backtrack from `dp[m][n]`: on a match take the char and go diagonally; otherwise move toward the larger of `dp[i-1][j]` and `dp[i][j-1]`. Reverse the collected chars.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(longestCommonSubsequence('abcde', 'ace'), 3);
assert.equal(longestCommonSubsequence('abc', 'abc'), 3);
assert.equal(longestCommonSubsequence('abc', 'def'), 0);
assert.equal(longestCommonSubsequence('', 'abc'), 0);
assert.equal(longestCommonSubsequence('bsbininm', 'jmjkbkjkv'), 1);
assert.equal(longestCommonSubsequence('AGGTAB', 'GXTXAYB'), 4);
```

</details>

</details>

---

<a id="algo-087"></a>
### algo-087. Word Break

*Dynamic programming (1D) · Medium*

Given a string `s` and a dictionary `wordDict`, return `true` if `s` can be split into a sequence of one or more dictionary words. Words may be reused.

- `s = "leetcode", wordDict = ["leet","code"]` -> `true`
- `s = "applepenapple", wordDict = ["apple","pen"]` -> `true`
- `s = "catsandog", wordDict = ["cats","dog","sand","and","cat"]` -> `false`

**Starter**

```ts
function wordBreak(s: string, wordDict: string[]): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
function wordBreak(s: string, wordDict: string[]): boolean {
  const words = new Set(wordDict);
  const maxLen = Math.max(0, ...wordDict.map((w) => w.length));
  // dp[i] = true if s.slice(0, i) can be segmented.
  const dp = new Array<boolean>(s.length + 1).fill(false);
  dp[0] = true;
  for (let i = 1; i <= s.length; i++) {
    for (let j = Math.max(0, i - maxLen); j < i; j++) {
      if (dp[j] && words.has(s.slice(j, i))) {
        dp[i] = true;
        break;
      }
    }
  }
  return dp[s.length];
}
```

**Why it works.** `dp[i]` says whether the prefix of length `i` can be segmented: it is true if some earlier split point `j` has `dp[j]` true and `s[j..i)` is a word. Naive recursion tries every split repeatedly and is exponential (e.g. `"aaaa...b"`); the DP is O(n^2) substring checks, or O(n * L) when limiting `j` to the longest word length L, with O(n) space (plus substring cost). Trap: greedy longest-match fails (`"cats"` vs `"cat"` + `"sand"`); and `dp[0] = true` for the empty prefix.

**Say it.** dp of i is true if some j before it is reachable and the substring from j to i is a word; I fill it left to right, only looking back as far as the longest word. Roughly O(n times L) checks.

**Follow-up.** Q: Return all possible sentences, not just true/false. A: DFS with memoization from each start index, returning the list of sentences for the suffix; the output itself can be exponential, so memoization mainly avoids recomputing shared suffixes (Word Break II).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(wordBreak('leetcode', ['leet', 'code']), true);
assert.equal(wordBreak('applepenapple', ['apple', 'pen']), true);
assert.equal(wordBreak('catsandog', ['cats', 'dog', 'sand', 'and', 'cat']), false);
assert.equal(wordBreak('a', []), false);
assert.equal(wordBreak('a'.repeat(150) + 'b', ['a', 'aa', 'aaa', 'aaaa']), false);
```

</details>

</details>

---

<a id="algo-088"></a>
### algo-088. Unique Paths

*Dynamic programming (2D grid) · Medium*

A robot is at the top-left corner of an `m x n` grid and can only move **right** or **down**. How many unique paths lead to the bottom-right corner?

- `m = 3, n = 7` -> `28`
- `m = 3, n = 2` -> `3`
- `m = 1, n = 1` -> `1`

**Starter**

```ts
function uniquePaths(m: number, n: number): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function uniquePaths(m: number, n: number): number {
  // row[j] = number of paths to cell (current row, j); one row is enough.
  const row = new Array<number>(n).fill(1);
  for (let i = 1; i < m; i++) {
    for (let j = 1; j < n; j++) {
      row[j] += row[j - 1]; // from above (old row[j]) + from the left (row[j - 1])
    }
  }
  return row[n - 1];
}
```

**Why it works.** Each cell can only be reached from above or from the left, so `paths[i][j] = paths[i-1][j] + paths[i][j-1]`, with the first row and column all 1. Recursion without memo is exponential; the DP is O(m * n) time, and a single rolling row gives O(n) space. Math alternative: choose which `m - 1` of the `m + n - 2` moves go down, `C(m + n - 2, m - 1)`, computed in O(min(m, n)).

**Say it.** Paths to a cell equal paths from above plus from the left; I keep one row and update it in place, giving O(m times n) time and O(n) space. It's also just a binomial coefficient.

**Follow-up.** Q: Some cells are obstacles. A: Same DP, but set the count to 0 for obstacle cells (and stop the 1s along the first row/column after an obstacle) (Unique Paths II).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(uniquePaths(3, 7), 28);
assert.equal(uniquePaths(3, 2), 3);
assert.equal(uniquePaths(1, 1), 1);
assert.equal(uniquePaths(1, 10), 1);
assert.equal(uniquePaths(10, 10), 48620);
```

</details>

</details>

---

<a id="algo-089"></a>
### algo-089. Edit Distance

*Dynamic programming (2D) · Hard*

Given two strings `word1` and `word2`, return the minimum number of operations to convert `word1` into `word2`. Allowed operations: insert a character, delete a character, replace a character.

- `"horse", "ros"` -> `3` (horse -> rorse -> rose -> ros)
- `"intention", "execution"` -> `5`
- `"", "abc"` -> `3`

**Starter**

```ts
function minDistance(word1: string, word2: string): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function minDistance(word1: string, word2: string): number {
  const m = word1.length;
  const n = word2.length;
  // prev[j] = edit distance between word1[0..i-1) and word2[0..j).
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = new Array<number>(n + 1);
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (word1[i - 1] === word2[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(
          prev[j - 1], // replace
          prev[j],     // delete from word1
          curr[j - 1], // insert into word1
        );
      }
    }
    prev = curr;
  }
  return prev[n];
}
```

**Why it works.** `dp[i][j]` is the edit distance between the first `i` chars of `word1` and the first `j` of `word2`. If the last chars match, it equals `dp[i-1][j-1]`; otherwise 1 + the min of replace (`dp[i-1][j-1]`), delete (`dp[i-1][j]`) and insert (`dp[i][j-1]`). Base cases: converting to or from an empty string costs its length. Brute-force recursion branches three ways and is exponential; the DP is O(m * n) time, O(n) space with two rows. Trap: forgetting the base row/column.

**Say it.** dp of i, j is the cost to convert the two prefixes: free on a character match, otherwise one plus the min of replace, delete or insert. O(m times n) time, two rows of space.

**Follow-up.** Q: Only insertions and deletions are allowed. A: Then the answer is `m + n - 2 * LCS(word1, word2)`: you delete everything not in the LCS from word1 and insert everything not in it from word2 (Delete Operation for Two Strings).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(minDistance('horse', 'ros'), 3);
assert.equal(minDistance('intention', 'execution'), 5);
assert.equal(minDistance('', 'abc'), 3);
assert.equal(minDistance('abc', ''), 3);
assert.equal(minDistance('same', 'same'), 0);
assert.equal(minDistance('kitten', 'sitting'), 3);
```

</details>

</details>

---

<a id="algo-090"></a>
### algo-090. Partition Equal Subset Sum

*Dynamic programming (0/1 knapsack) · Medium*

Given an array of positive integers `nums`, return `true` if it can be split into two subsets with equal sums.

- `[1,5,11,5]` -> `true` ([1,5,5] and [11])
- `[1,2,3,5]` -> `false`
- `[2,2]` -> `true`

**Starter**

```ts
function canPartition(nums: number[]): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
function canPartition(nums: number[]): boolean {
  const total = nums.reduce((a, b) => a + b, 0);
  if (total % 2 !== 0) return false;
  const target = total / 2;
  // reachable[s] = some subset of the numbers seen so far sums to s.
  const reachable = new Array<boolean>(target + 1).fill(false);
  reachable[0] = true;
  for (const x of nums) {
    // Iterate downwards so each number is used at most once.
    for (let s = target; s >= x; s--) {
      if (reachable[s - x]) reachable[s] = true;
    }
    if (reachable[target]) return true;
  }
  return reachable[target];
}
```

**Why it works.** Two equal halves exist exactly when the total is even and some subset sums to `total / 2`: a 0/1 knapsack (subset sum) problem. Trying all subsets is O(2^n); the DP over reachable sums is O(n * target) time and O(target) space. Trap: iterate `s` from high to low in the 1D array, otherwise a number can be counted twice in the same round. Early exit when the total is odd.

**Say it.** If the total is odd it's impossible; otherwise I need a subset summing to half, which is 0/1 knapsack: a boolean array of reachable sums updated backwards for each number. O(n times target) time, O(target) space.

**Follow-up.** Q: Minimize the difference between the two subsets' sums instead. A: Run the same reachable-sums DP up to `total / 2`, then take the largest reachable `s <= total / 2`; the answer is `total - 2 * s` (Last Stone Weight II style).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(canPartition([1, 5, 11, 5]), true);
assert.equal(canPartition([1, 2, 3, 5]), false);
assert.equal(canPartition([2, 2]), true);
assert.equal(canPartition([1]), false);
assert.equal(canPartition([3, 3, 3, 4, 5]), true);
assert.equal(canPartition([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 99, 97]), false);
```

</details>

</details>

---

<a id="algo-091"></a>
### algo-091. Maximum Subarray

*Dynamic programming (Kadane) · Easy*

Given an integer array `nums` (at least one element), find the contiguous subarray with the largest sum and return that sum.

- `[-2,1,-3,4,-1,2,1,-5,4]` -> `6` (subarray [4,-1,2,1])
- `[1]` -> `1`
- `[-3,-1,-2]` -> `-1`

**Starter**

```ts
function maxSubArray(nums: number[]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function maxSubArray(nums: number[]): number {
  let best = nums[0];
  let current = nums[0]; // best sum of a subarray ending at the current index
  for (let i = 1; i < nums.length; i++) {
    current = Math.max(nums[i], current + nums[i]); // extend or start fresh
    best = Math.max(best, current);
  }
  return best;
}
```

**Why it works.** Kadane's algorithm: the best subarray ending at index `i` either extends the best one ending at `i - 1` or starts fresh at `i`, whichever is larger; track the overall maximum. Brute force checks all O(n^2) subarrays (O(n^3) if sums are recomputed); Kadane is O(n) time and O(1) space. Trap: initialising `best` to 0 returns the wrong answer for all-negative arrays.

**Say it.** Kadane's: for each element I either extend the running subarray or restart from it, whichever is bigger, and track the best seen. O(n) time, O(1) space.

**Follow-up.** Q: Return the start and end indices too. A: Track a tentative start that resets to `i` whenever you start fresh, and record `[start, i]` whenever `best` improves.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(maxSubArray([-2, 1, -3, 4, -1, 2, 1, -5, 4]), 6);
assert.equal(maxSubArray([1]), 1);
assert.equal(maxSubArray([-3, -1, -2]), -1);
assert.equal(maxSubArray([5, 4, -1, 7, 8]), 23);
assert.equal(maxSubArray([-1, 3, -2, 5, -10, 4]), 6);
```

</details>

</details>

---

<a id="algo-092"></a>
### algo-092. Decode Ways

*Dynamic programming (1D) · Medium*

Letters are encoded as numbers: `A -> "1"`, `B -> "2"`, ..., `Z -> "26"`. Given a string `s` of digits, return the number of ways to decode it. Codes with a leading zero (like `"06"`) are invalid.

- `"12"` -> `2` ("AB" or "L")
- `"226"` -> `3` ("BZ", "VF", "BBF")
- `"06"` -> `0`

**Starter**

```ts
function numDecodings(s: string): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function numDecodings(s: string): number {
  // prev2 = ways to decode s[0..i-2), prev1 = ways to decode s[0..i-1).
  let prev2 = 1;
  let prev1 = s.length > 0 && s[0] !== '0' ? 1 : 0;
  for (let i = 2; i <= s.length; i++) {
    let curr = 0;
    if (s[i - 1] !== '0') curr += prev1; // single digit 1-9
    const two = Number(s.slice(i - 2, i));
    if (two >= 10 && two <= 26) curr += prev2; // two digits 10-26
    prev2 = prev1;
    prev1 = curr;
  }
  return prev1;
}
```

**Why it works.** Like Climbing Stairs with conditions: the last letter used either one digit (valid if it is not `0`) or two digits (valid if they form 10-26). So `ways(i) = (s[i-1] != '0' ? ways(i-1) : 0) + (10 <= s[i-2..i) <= 26 ? ways(i-2) : 0)`. Plain recursion is exponential; the DP is O(n) time and O(1) space with two rolling variables. Traps: zeros (`"0"`, `"06"`, `"100"` all give 0) and treating `"05"` as a valid two-digit code.

**Say it.** At each position I add the ways from one step back if the single digit is 1 through 9, and from two steps back if the two digits form 10 through 26, keeping two rolling values. O(n) time, O(1) space.

**Follow-up.** Q: What if `*` can stand for any digit 1-9? A: Same DP, but each step multiplies by the number of valid interpretations: `*` alone has 9, `1*` has 9 two-digit options, `2*` has 6, `**` has 15; take results modulo 1e9+7 (Decode Ways II).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(numDecodings('12'), 2);
assert.equal(numDecodings('226'), 3);
assert.equal(numDecodings('06'), 0);
assert.equal(numDecodings('0'), 0);
assert.equal(numDecodings('10'), 1);
assert.equal(numDecodings('100'), 0);
assert.equal(numDecodings('11106'), 2);
```

</details>

</details>

---

<a id="algo-093"></a>
### algo-093. Jump Game

*Greedy · Medium*

You start at index 0 of `nums`; `nums[i]` is the **maximum** jump length from index `i`. Return `true` if you can reach the last index.

- `[2,3,1,1,4]` -> `true`
- `[3,2,1,0,4]` -> `false` (you always land on index 3, whose jump is 0)
- `[0]` -> `true`

**Starter**

```ts
function canJump(nums: number[]): boolean {
  // TODO
  return false;
}
```

<details>
<summary>Solution</summary>

```ts
function canJump(nums: number[]): boolean {
  let farthest = 0; // farthest index reachable so far
  for (let i = 0; i < nums.length; i++) {
    if (i > farthest) return false; // stuck before reaching i
    farthest = Math.max(farthest, i + nums[i]);
    if (farthest >= nums.length - 1) return true;
  }
  return true;
}
```

**Why it works.** Greedy: sweep left to right tracking the farthest index reachable so far. If you ever stand at an index beyond that reach, you are stuck; if the reach covers the last index, you win. A DP/backtracking approach that tries every jump is O(n^2) or worse; the greedy is O(n) time, O(1) space. Trap: a single-element array is already at the end.

**Say it.** I scan once keeping the farthest reachable index; if the current index ever goes past it I return false, and if it reaches the end I return true. O(n) time, O(1) space.

**Follow-up.** Q: Return the minimum number of jumps to reach the end (it is always reachable). A: Greedy BFS by levels: track the end of the current jump's range and the farthest reach within it; when `i` hits the current end, increment jumps and set end = farthest. O(n) (Jump Game II).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(canJump([2, 3, 1, 1, 4]), true);
assert.equal(canJump([3, 2, 1, 0, 4]), false);
assert.equal(canJump([0]), true);
assert.equal(canJump([0, 1]), false);
assert.equal(canJump([2, 0, 0]), true);
assert.equal(canJump([1, 1, 0, 1]), false);
```

</details>

</details>

---

<a id="algo-094"></a>
### algo-094. Gas Station

*Greedy · Medium*

There are `n` gas stations on a circular route. Station `i` has `gas[i]` fuel, and driving from station `i` to `i + 1` costs `cost[i]`. You start with an empty tank. Return the starting station index that lets you travel around the circuit once clockwise, or `-1` if none. The answer is guaranteed unique if it exists.

- `gas = [1,2,3,4,5], cost = [3,4,5,1,2]` -> `3`
- `gas = [2,3,4], cost = [3,4,3]` -> `-1`

**Starter**

```ts
function canCompleteCircuit(gas: number[], cost: number[]): number {
  // TODO
  return -1;
}
```

<details>
<summary>Solution</summary>

```ts
function canCompleteCircuit(gas: number[], cost: number[]): number {
  let total = 0; // net fuel over the whole loop
  let tank = 0;  // net fuel since the current candidate start
  let start = 0;
  for (let i = 0; i < gas.length; i++) {
    const diff = gas[i] - cost[i];
    total += diff;
    tank += diff;
    if (tank < 0) {
      // No station in [start, i] can be a valid start: try i + 1.
      start = i + 1;
      tank = 0;
    }
  }
  return total >= 0 ? start : -1;
}
```

**Why it works.** Two facts: if total gas is less than total cost no start works; and if you run dry going from `start` to `i`, no station between them can work either (each started with a non-negative surplus that still was not enough), so jump the candidate to `i + 1`. Simulating from every start is O(n^2); this single pass is O(n) time, O(1) space. Trap: forgetting the global `total >= 0` check, which is what guarantees the final candidate actually completes the loop.

**Say it.** If total gas is at least total cost a solution exists; I scan once with a running tank, and whenever it goes negative I move the start to the next station, because nothing in between could work. O(n), O(1).

**Follow-up.** Q: Why does the last candidate always work when total >= 0? A: The segment from `start` to the end has a non-negative tank, and the segment before `start` has a total deficit no larger than what the total surplus covers, so carrying the surplus around the wrap-around covers it.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(canCompleteCircuit([1, 2, 3, 4, 5], [3, 4, 5, 1, 2]), 3);
assert.equal(canCompleteCircuit([2, 3, 4], [3, 4, 3]), -1);
assert.equal(canCompleteCircuit([5], [4]), 0);
assert.equal(canCompleteCircuit([5, 1, 2, 3, 4], [4, 4, 1, 5, 1]), 4);
assert.equal(canCompleteCircuit([3, 1, 1], [1, 2, 2]), 0);
```

</details>

</details>

---

<a id="algo-095"></a>
### algo-095. Best Time to Buy and Sell Stock II

*Greedy · Easy*

`prices[i]` is a stock's price on day `i`. You may buy and sell as many times as you like but hold at most one share at a time (you can sell and buy again on the same day). Return the maximum profit.

- `[7,1,5,3,6,4]` -> `7` (buy 1 sell 5, buy 3 sell 6)
- `[1,2,3,4,5]` -> `4`
- `[7,6,4,3,1]` -> `0`

**Starter**

```ts
function maxProfit(prices: number[]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function maxProfit(prices: number[]): number {
  let profit = 0;
  for (let i = 1; i < prices.length; i++) {
    // Collect every upward move; a long rise equals the sum of its daily rises.
    if (prices[i] > prices[i - 1]) profit += prices[i] - prices[i - 1];
  }
  return profit;
}
```

**Why it works.** With unlimited transactions, the best you can do is capture every price increase: any rise from day a to day b equals the sum of the day-to-day rises in between, so summing all positive daily differences is optimal. Trying all buy/sell combinations is exponential; the greedy is O(n) time, O(1) space. Equivalent DP: track `hold` and `cash` states per day. Trap: confusing it with the single-transaction version (track min price so far).

**Say it.** Since I can trade unlimited times, I just add up every positive day-to-day difference, which equals the profit from buying at every valley and selling at every peak. O(n) time, O(1) space.

**Follow-up.** Q: Each sale now costs a fixed fee. A: Greedy no longer works directly; use the two-state DP: `cash = max(cash, hold + price - fee)`, `hold = max(hold, cash - price)`. O(n), O(1).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(maxProfit([7, 1, 5, 3, 6, 4]), 7);
assert.equal(maxProfit([1, 2, 3, 4, 5]), 4);
assert.equal(maxProfit([7, 6, 4, 3, 1]), 0);
assert.equal(maxProfit([]), 0);
assert.equal(maxProfit([3, 3, 5, 0, 0, 3, 1, 4]), 8);
```

</details>

</details>

---

<a id="algo-096"></a>
### algo-096. Implement Trie (Prefix Tree)

*Trie · Medium*

Implement a `Trie` class with:
- `insert(word)` - adds a word.
- `search(word)` - `true` if the exact word was inserted.
- `startsWith(prefix)` - `true` if any inserted word starts with `prefix`.

```
insert("apple"); search("apple") -> true; search("app") -> false
startsWith("app") -> true; insert("app"); search("app") -> true
```

**Starter**

```ts
class Trie {
  insert(word: string): void {
    // TODO
  }
  search(word: string): boolean {
    // TODO
    return false;
  }
  startsWith(prefix: string): boolean {
    // TODO
    return false;
  }
}
```

<details>
<summary>Solution</summary>

```ts
class TrieNode {
  children = new Map<string, TrieNode>();
  isWord = false;
}

class Trie {
  private root = new TrieNode();

  insert(word: string): void {
    let node = this.root;
    for (const ch of word) {
      let next = node.children.get(ch);
      if (!next) {
        next = new TrieNode();
        node.children.set(ch, next);
      }
      node = next;
    }
    node.isWord = true;
  }

  search(word: string): boolean {
    return this.walk(word)?.isWord ?? false;
  }

  startsWith(prefix: string): boolean {
    return this.walk(prefix) !== null;
  }

  // Returns the node at the end of the path for s, or null if the path breaks.
  private walk(s: string): TrieNode | null {
    let node = this.root;
    for (const ch of s) {
      const next = node.children.get(ch);
      if (!next) return null;
      node = next;
    }
    return node;
  }
}
```

**Why it works.** Each node maps a character to a child and has an `isWord` flag; a word is a path from the root. Insert creates missing nodes, while `search` and `startsWith` share one walk and differ only in whether the final node must be marked as a word end. Every operation is O(L) for a string of length L; space is O(total characters inserted). Compared with storing words in a Set, prefix queries drop from O(N * L) (scan every word) to O(L). Trap: `search("app")` must be false until "app" itself is inserted.

**Say it.** Each trie node has a map of children and an end-of-word flag; insert creates the path, search walks it and checks the flag, startsWith only checks that the path exists. All O(length of the word).

**Follow-up.** Q: How would you return autocomplete suggestions for a prefix? A: Walk to the prefix node, then DFS below it collecting words (optionally store the top-k most frequent words at each node to answer instantly).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const t = new Trie();
t.insert('apple');
assert.equal(t.search('apple'), true);
assert.equal(t.search('app'), false);
assert.equal(t.startsWith('app'), true);
t.insert('app');
assert.equal(t.search('app'), true);
assert.equal(t.startsWith('b'), false);
assert.equal(t.startsWith(''), true);
assert.equal(t.search('apples'), false);
```

</details>

</details>

---

<a id="algo-097"></a>
### algo-097. Design Add and Search Words Data Structure

*Trie + DFS · Medium*

Design `WordDictionary` with:
- `addWord(word)` - adds a word.
- `search(word)` - `true` if any added word matches; `word` may contain `.` which matches **any one** letter.

```
addWord("bad"); addWord("dad"); addWord("mad")
search("pad") -> false; search("bad") -> true
search(".ad") -> true;  search("b..") -> true
```

**Starter**

```ts
class WordDictionary {
  addWord(word: string): void {
    // TODO
  }
  search(word: string): boolean {
    // TODO
    return false;
  }
}
```

<details>
<summary>Solution</summary>

```ts
class TrieNode {
  children = new Map<string, TrieNode>();
  isWord = false;
}

class WordDictionary {
  private root = new TrieNode();

  addWord(word: string): void {
    let node = this.root;
    for (const ch of word) {
      let next = node.children.get(ch);
      if (!next) {
        next = new TrieNode();
        node.children.set(ch, next);
      }
      node = next;
    }
    node.isWord = true;
  }

  search(word: string): boolean {
    const dfs = (node: TrieNode, i: number): boolean => {
      if (i === word.length) return node.isWord;
      const ch = word[i];
      if (ch === '.') {
        // Wildcard: try every child.
        for (const child of node.children.values()) {
          if (dfs(child, i + 1)) return true;
        }
        return false;
      }
      const next = node.children.get(ch);
      return next !== undefined && dfs(next, i + 1);
    };
    return dfs(this.root, 0);
  }
}
```

**Why it works.** Store words in a trie. Regular characters follow a single child; a `.` branches into every child, so search becomes a DFS over the trie. `addWord` is O(L); `search` is O(L) without wildcards and up to O(26^d * L) in the worst case with d dots (bounded by the trie size). Scanning a list of all words and regex-matching each is O(N * L) per query. Trap: at the end of the pattern you must check `isWord`, not just that a node exists.

**Say it.** I store words in a trie; search walks it normally, and on a dot it tries every child recursively, returning true at the end only if the node marks a complete word.

**Follow-up.** Q: How would you speed up searches like "....." on a huge dictionary? A: Also bucket words by length (a separate trie or list per length), so wildcard-heavy queries only explore words of the right length; cache frequent query results.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const d = new WordDictionary();
d.addWord('bad');
d.addWord('dad');
d.addWord('mad');
assert.equal(d.search('pad'), false);
assert.equal(d.search('bad'), true);
assert.equal(d.search('.ad'), true);
assert.equal(d.search('b..'), true);
assert.equal(d.search('b.'), false);
assert.equal(d.search('...'), true);
assert.equal(d.search('....'), false);
```

</details>

</details>

---

<a id="algo-098"></a>
### algo-098. Single Number

*Bit manipulation · Easy*

Given a non-empty integer array `nums` where every element appears **twice** except for one, find that single one. Use O(n) time and O(1) extra space.

- `[2,2,1]` -> `1`
- `[4,1,2,1,2]` -> `4`
- `[1]` -> `1`

**Starter**

```ts
function singleNumber(nums: number[]): number {
  // TODO
  return 0;
}
```

<details>
<summary>Solution</summary>

```ts
function singleNumber(nums: number[]): number {
  // x ^ x = 0 and x ^ 0 = x, and XOR is order-independent: pairs cancel out.
  let result = 0;
  for (const n of nums) result ^= n;
  return result;
}
```

**Why it works.** XOR all the numbers: equal pairs cancel (`x ^ x = 0`), XOR is commutative and associative, and `0 ^ x = x`, so only the single number is left. A hash map/set of counts also works but costs O(n) space; sorting costs O(n log n). XOR is O(n) time, O(1) space. Note: JS bitwise operators work on 32-bit signed integers, which is fine for this problem's constraints.

**Say it.** I XOR everything together: duplicates cancel to zero and the leftover is the single number. O(n) time, O(1) space.

**Follow-up.** Q: Every element appears three times except one. A: Count set bits per position modulo 3 (or use the `ones`/`twos` bitmask trick: `ones = (ones ^ x) & ~twos; twos = (twos ^ x) & ~ones`). O(n) time, O(1) space (Single Number II).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.equal(singleNumber([2, 2, 1]), 1);
assert.equal(singleNumber([4, 1, 2, 1, 2]), 4);
assert.equal(singleNumber([1]), 1);
assert.equal(singleNumber([-3, 7, 7]), -3);
assert.equal(singleNumber([0, 5, 5]), 0);
```

</details>

</details>

---

<a id="algo-099"></a>
### algo-099. Counting Bits

*Bit manipulation + DP · Easy*

Given an integer `n`, return an array `ans` of length `n + 1` where `ans[i]` is the number of `1` bits in the binary representation of `i`. Aim for O(n).

- `n = 2` -> `[0,1,1]`
- `n = 5` -> `[0,1,1,2,1,2]`

(Also write `hammingWeight(x)` that counts the 1 bits of a single non-negative integer.)

**Starter**

```ts
function hammingWeight(x: number): number {
  // TODO
  return 0;
}

function countBits(n: number): number[] {
  // TODO
  return [];
}
```

<details>
<summary>Solution</summary>

```ts
function hammingWeight(x: number): number {
  let count = 0;
  while (x !== 0) {
    x &= x - 1; // clears the lowest set bit
    count++;
  }
  return count;
}

function countBits(n: number): number[] {
  const ans = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    // i >> 1 drops the last bit (already computed); add it back with i & 1.
    ans[i] = ans[i >> 1] + (i & 1);
  }
  return ans;
}
```

**Why it works.** For one number, `x & (x - 1)` removes the lowest set bit, so the loop runs once per 1 bit (Brian Kernighan's trick). Calling that for every `i` gives O(n log n) for `countBits`; the DP `ans[i] = ans[i >> 1] + (i & 1)` reuses the answer for `i` without its last bit, giving O(n) time and O(1) extra space besides the output. Trap: in JS, bitwise ops are 32-bit signed, so for values above 2^31 - 1 use `x >>> 0` or arithmetic division.

**Say it.** For a single number I clear the lowest set bit with x and x minus one until it's zero; for the whole range I use dp: bits of i equal bits of i shifted right by one plus its last bit. O(n) total.

**Follow-up.** Q: Another O(n) recurrence? A: `ans[i] = ans[i & (i - 1)] + 1`: removing the lowest set bit gives a smaller number with exactly one fewer 1 bit.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
assert.deepEqual(countBits(2), [0, 1, 1]);
assert.deepEqual(countBits(5), [0, 1, 1, 2, 1, 2]);
assert.deepEqual(countBits(0), [0]);
assert.equal(hammingWeight(11), 3);
assert.equal(hammingWeight(128), 1);
assert.equal(hammingWeight(2147483647), 31);
assert.equal(countBits(1023)[1023], 10);
```

</details>

</details>

---

<a id="algo-100"></a>
### algo-100. LRU Cache

*Design (hash map + ordering) · Medium*

Design an `LRUCache` with a fixed `capacity`:
- `get(key)` returns the value or `-1` if missing, and marks the key as most recently used.
- `put(key, value)` inserts or updates; if this exceeds capacity, evict the **least recently used** key.

Both must run in O(1) average time.
```
cap 2: put(1,1); put(2,2); get(1) -> 1
put(3,3)   // evicts key 2
get(2) -> -1; get(3) -> 3
```

**Starter**

```ts
class LRUCache {
  constructor(capacity: number) {
    // TODO
  }
  get(key: number): number {
    // TODO
    return -1;
  }
  put(key: number, value: number): void {
    // TODO
  }
}
```

<details>
<summary>Solution</summary>

```ts
class LRUCache {
  private capacity: number;
  // A JS Map iterates in insertion order: first key = least recently used.
  private map = new Map<number, number>();

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get(key: number): number {
    if (!this.map.has(key)) return -1;
    const value = this.map.get(key)!;
    this.map.delete(key); // re-insert to move it to the "most recent" end
    this.map.set(key, value);
    return value;
  }

  put(key: number, value: number): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
    }
  }
}
```

**Why it works.** A JavaScript `Map` remembers insertion order, so deleting and re-inserting a key moves it to the end (most recent), and `map.keys().next()` gives the least recently used key to evict. All operations are O(1) average time, O(capacity) space. In languages without an ordered hash map (or if the interviewer forbids relying on it), combine a hash map from key to node with a doubly linked list: move nodes to the head on access and evict from the tail. Trap: `put` on an existing key must refresh its recency, and must not evict when only updating.

**Say it.** I use a Map because it keeps insertion order: on every get or put I delete and re-insert the key so it becomes most recent, and when over capacity I evict the first key. Everything is O(1).

**Follow-up.** Q: The interviewer says "don't rely on Map ordering". A: Implement a doubly linked list with dummy head and tail nodes plus a `Map<key, node>`; get moves the node to the front, put inserts at the front and removes `tail.prev` when over capacity. Still O(1) per operation.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';
const c = new LRUCache(2);
c.put(1, 1);
c.put(2, 2);
assert.equal(c.get(1), 1);
c.put(3, 3); // evicts 2
assert.equal(c.get(2), -1);
c.put(4, 4); // evicts 1
assert.equal(c.get(1), -1);
assert.equal(c.get(3), 3);
assert.equal(c.get(4), 4);
const d = new LRUCache(2);
d.put(1, 1);
d.put(2, 2);
d.put(1, 10); // update refreshes recency, no eviction
d.put(3, 3); // evicts 2
assert.equal(d.get(1), 10);
assert.equal(d.get(2), -1);
```

</details>

</details>

---

