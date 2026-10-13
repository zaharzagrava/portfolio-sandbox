---
id: damping-factor
title: Damping factor
kind: term
status: draft
aliases: [damping]
defined_for: S34-recommendations
rules_hash: e3b0c44298fc
---
# Damping factor
## Definition
The damping factor is the fixed multiplier applied to the score of every indirect ([`hops: 2`](hops.md)) item in a [2-hop lookup](two-hop-lookup.md). The item's score is the [seed score](neighbour-score.md) times the entry score times the damping factor. As a result, an indirect item always gets a lower score than the path it was reached through. Every second-hop score gets the same factor, and [direct neighbours](direct-neighbour.md) always rank first, so the factor does not change the order of items. It changes only the score shown in the response. Design intent (not stated in the spec): the factor marks a two-step link as weaker evidence than a direct [co-purchase](co-occurrence-graph.md).

## Example
In S34.B-06, product `S` has one direct neighbour, `K` (0.2046, hops 1). The expansion through `K` adds `P` with score 0.0673 and hops 2. The rule (S34.R-10) for that score is:
```
second-hop score = seed score × entry score × 0.5
illustrative: 0.4 × 0.3 × 0.5 = 0.06
```

## Known gaps
- The spec does not say whether the factor can be changed in [`recommendations-config.ts`](recommendations-config.md) or is fixed in `two-hop-blend.ts#blendTwoHop`. The config file is said to hold thresholds, caps, TTLs and budgets, and the factor is not named among them.
- The spec does not say why this value of the factor was chosen.

## Used by
<!-- used-by:start -->
- [best-path](best-path.md)
- [co-occurrence-graph](co-occurrence-graph.md)
- [direct-neighbour](direct-neighbour.md)
- [neighbour-score](neighbour-score.md)
- [two-hop-lookup](two-hop-lookup.md)
<!-- used-by:end -->
