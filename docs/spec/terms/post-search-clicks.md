---
id: post-search-clicks
title: POST /search/clicks
kind: term
status: draft
aliases: [/search/clicks, search/clicks]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# POST /search/clicks
## Definition
`POST /search/clicks` is the [S32](../capabilities/S32-product-search.md) endpoint a client calls when a user clicks a result from a product search. It records the click and answers right away with an "accepted" status, before the click is fully processed. S32 emits a [`search.result_clicked` event](search-result-clicked-event.md) and also consumes that event, so the click is most likely saved to the [click log](click-log.md) afterwards, not during the request. That is design intent (not stated in the spec). Clicks are the input for the [click-through rate](click-through-rate.md) and [MRR](mrr.md) figures in `GET /admin/search/quality`.

## Example
```
GET /products/search?q=iphone   → 200 { "items": [...], "searchId": "<signed id>" }
POST /search/clicks              → 202
```
The click body is not specified. It probably carries the [`searchId`](search-id.md) and the clicked product id (illustrative).

## Known gaps
- The spec does not say what the request body contains, whether `searchId` is required, or what a click with an invalid or forged `searchId` returns.
- The spec does not say whether this endpoint has a rate limit or needs authentication.
- The spec does not say that duplicate clicks are handled safely: [consumer idempotency](consumer-deduplication-mode.md) (AS-72) has no test.

## Used by
<!-- used-by:start -->
- [click-log](click-log.md)
- [click-through-rate](click-through-rate.md)
- [consumer-deduplication-mode](consumer-deduplication-mode.md)
- [mrr](mrr.md)
- [search-result-clicked-event](search-result-clicked-event.md)
<!-- used-by:end -->
