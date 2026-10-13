---
id: search-result-clicked-event
title: search.result_clicked event
kind: term
status: draft
aliases: [search.result_clicked]
defined_for: S32-product-search
rules_hash: a9d60e57bd55
---
# search.result_clicked event
## Definition
`search.result_clicked` is the event that [S32](../capabilities/S32-product-search.md) emits when a user clicks a product search result. S32 also consumes this event itself. The likely flow: [`POST /search/clicks`](post-search-clicks.md) accepts the click, emits the event, and a consumer writes it to the [click log](click-log.md) later. That flow is design intent (not stated in the spec). Click data feeds the [click-through rate](click-through-rate.md) and [MRR](mrr.md) figures in [`GET /admin/search/quality`](get-admin-search-quality.md).

## Example
```
GET /products/search?q=iphone   → 200 { "items": [...], "searchId": "<signed id>" }
POST /search/clicks              → 202
→ search.result_clicked emitted, then consumed by S32 and recorded in the click log
```
The fields in the event payload are not specified. A `searchId` and a clicked `productId` would be reasonable, but this is only an illustration.

## Known gaps
- The spec does not say what the event payload contains or which version of it consumers accept.
- The spec does not say that duplicate deliveries are handled safely. Consumer idempotency (AS-72) has no test.
- The spec does not say whether any service outside S32 consumes this event.

## Used by
<!-- used-by:start -->
- [click-log](click-log.md)
- [click-through-rate](click-through-rate.md)
- [mrr](mrr.md)
- [post-search-clicks](post-search-clicks.md)
<!-- used-by:end -->
