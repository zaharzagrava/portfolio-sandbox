---
id: sponsorship-event
title: Sponsorship event
kind: term
status: draft
aliases: [sponsored]
defined_for: S32-product-search
rules_hash: d89d3cf7fa75
---
# Sponsorship event
## Definition
A sponsorship event is the `marketing.product_sponsorship_changed` message that search consumes to mark whether a product is sponsored. When the event is [projected ↗](../sw-external-terms.md#projection), the [search item](search-items.md) shows `sponsored: true` and the product gets the [sponsorship boost](relevance-boost.md). This source has its own [version guard](version-guard.md), so a late, older sponsorship event is ignored and arrival order does not change the final document.

## Example
A newer sponsorship event arrives first, and an older one arrives after it. The item keeps `sponsored: true` from the newer event, and the [stale](consumer-outcomes.md) event is counted.

## Known gaps
- The spec does not describe the payload fields of `marketing.product_sponsorship_changed`, and it does not say how an end of sponsorship is signalled.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): B-12
- [W02](../capabilities/W02-storefront-discovery.md): R-14
- [business-score](business-score.md)
- [combined-business-multiplier](combined-business-multiplier.md)
- [consumer-outcomes](consumer-outcomes.md)
- [relevance-boost](relevance-boost.md)
- [search-items](search-items.md)
- [version-guard](version-guard.md)
<!-- used-by:end -->
