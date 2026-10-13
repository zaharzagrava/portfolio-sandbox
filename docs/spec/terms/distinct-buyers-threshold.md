---
id: distinct-buyers-threshold
title: Distinct buyers threshold
kind: term
status: draft
aliases: [buyers]
defined_for: S34-recommendations
rules_hash: 2a9900fb8894
---
# Distinct buyers threshold
## Definition
The distinct buyers threshold is the minimum number of different buyers who must have ordered two products together before the [build](order-baskets-build.md) links them. It applies alongside a separate minimum on how many orders contain both products. A pair must meet both minimums before the build links it. The purpose is that one buyer cannot create a link, however many times they buy the same pair together.

## Example
Pair `A–B` has 5 co-orders, all from one buyer. Pair `A–D` has 3 co-orders from 3 different buyers. After the build, `A`'s list includes `D` but not `B` (S34.B-15).

## Known gaps
- The spec does not say which field identifies a buyer, for example a user account or a [guest](guest-cart.md). It also does not say how guest orders count.
- Not confirmed in the code: R-16, which holds both thresholds, has no code link. Scenario AS-23, the noise threshold, has no test with its id.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): B-15
- [build-counts](build-counts.md)
- [co-order-threshold](co-order-threshold.md)
- [guest-cart](guest-cart.md)
- [order-baskets-build](order-baskets-build.md)
- [recommendations-config](recommendations-config.md)
<!-- used-by:end -->
