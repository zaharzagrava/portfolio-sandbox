---
id: direct-neighbour
title: Direct neighbour
kind: term
status: draft
aliases: [direct neighbours, neighbours]
defined_for: projection-and-replay
rules_hash: 42c9c848019f
---
# Direct neighbour
## Definition
A direct neighbour of a product is another product joined to it by one step in the record of which products were purchased together. This means the two products appeared together in at least one recorded purchase. Direct neighbours are the usual source of suggestions for items commonly purchased alongside a product. When a product has too few of them, a wider search reaches one step further, to their neighbours. The spec uses the phrase but does not define it.

## Example
Illustrative: one basket recorded from an [order.paid event](order-paid-event.md) contains `p_kettle` and `p_mug`.
`p_mug` is now a direct neighbour of `p_kettle`, and `p_kettle` is a direct neighbour of `p_mug`.

## Known gaps
- The spec does not say whether a single shared basket is enough to make two products neighbours, or whether some threshold applies after [normalisation](basket-normalisation.md).
- The spec does not say how many direct neighbours a product needs before the [cold-start strategy](cold-start-strategy.md) stops applying.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): R-07, R-08, R-09, R-11, B-02, B-06, B-07
- [atomic-list-swap](atomic-list-swap.md)
- [basket-normalisation](basket-normalisation.md)
- [basket](basket.md)
- [best-path](best-path.md)
- [bought-together](bought-together.md)
- [bucket-count](bucket-count.md)
- [co-occurrence-graph](co-occurrence-graph.md)
- [cold-start-strategy](cold-start-strategy.md)
- [damping-factor](damping-factor.md)
- [get-product-recommendations](get-product-recommendations.md)
- [hops](hops.md)
- [neighbour-score](neighbour-score.md)
- [no-padding](no-padding.md)
- [order-baskets-build](order-baskets-build.md)
- [order-paid-event](order-paid-event.md)
- [recommendation-rail](recommendation-rail.md)
- [recommendations-unavailable](recommendations-unavailable.md)
- [skipped-locked](skipped-locked.md)
- [two-hop-lookup](two-hop-lookup.md)
- [verify-totp](verify-totp.md)
<!-- used-by:end -->
