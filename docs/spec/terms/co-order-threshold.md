---
id: co-order-threshold
title: Co-order threshold
kind: term
status: draft
aliases: [co-orders, noise threshold]
defined_for: S34-recommendations
rules_hash: e3b0c44298fc
---
# Co-order threshold
## Definition
The co-order threshold is the minimum number of [baskets](basket.md) that must contain both products before the build links the pair. A co-order is one paid order whose basket holds both products. Only baskets inside the [build window](build-window.md) count. A pair must meet this threshold and the [distinct buyers threshold](distinct-buyers-threshold.md) to become an [edge](co-occurrence-graph.md) in the co-occurrence graph. Scenario AS-23 calls it the noise threshold: pairs bought together only rarely are left out.

## Example
Pair `M–S` appears together in 2 baskets, so the build leaves it out because it is below the threshold of 3 (AS-23).
Pair `A–B` has 5 co-orders, all from one buyer. It meets the co-order threshold but fails the distinct buyers threshold, so `A` does not list `B` (S34.B-15).

## Known gaps
- Not confirmed in the code: rule S34.R-16, which sets this threshold, has no code link. Scenario AS-23, which shows it in use, has no test that carries its id.
- The spec does not say whether you can change the threshold without a deploy. It only says the thresholds are kept in [`recommendations-config.ts`](recommendations-config.md) and checked at startup, and that check (FR-029) is unverified.

## Used by
<!-- used-by:start -->
- [basket](basket.md)
- [build-window](build-window.md)
- [co-occurrence-graph](co-occurrence-graph.md)
- [distinct-buyers-threshold](distinct-buyers-threshold.md)
- [recommendations-config](recommendations-config.md)
<!-- used-by:end -->
