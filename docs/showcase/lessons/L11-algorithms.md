# L11 — Algorithms (only where genuinely needed, D6)

| Algorithm | Feature that needs it | Why it's genuine |
|---|---|---|
| Trie with per-node top-K | SD-12 autocomplete | O(prefix) lookups at 50k RPS, no subtree scan |
| Count-Min Sketch + min-heap top-K | SD-32 trending | 50M-cardinality counting in bounded memory |
| Bloom filter | SD-35 seen URLs, SD-34 cache penetration | 100M-member set membership in MBs |
| SimHash | SD-35 change detection | near-duplicate detection without diffing HTML |
| Consistent hashing (virtual nodes) | SD-16 room routing, SD-23 city ownership | we route keys to instances ourselves |
| Reservoir sampling | SD-15 comment sampling | uniform sample of unbounded stream per window |
| Topological sort (DAG scheduling) | SD-26 transcoding pipeline | task dependencies |
| Hot / Wilson score ranking | SD-11 | standard ranking functions |
| Base62 + Feistel bijection | SD-08 | non-guessable codes without collisions |
| Largest-remainder allocation | F-01 money, SD-19, SD-24 | exact money splits |
| BFS with decay (2-hop) | X-01 | cold-start recommendations |
| k-way merge by ID | SD-09 celebrity merge | merging sorted timelines |
| Content-defined chunking (FastCDC rolling hash) | SD-25 | stable chunk boundaries for delta sync |
| Reciprocal rank fusion | SD-43 | hybrid retrieval |
| DP (knapsack etc.) | no feature needs it → **skipped** | — |
