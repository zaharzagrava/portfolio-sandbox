---
id: click-log
title: Click log
kind: term
status: draft
aliases: [click logs]
defined_for: S32-product-search
rules_hash: 6a3e2e166793
---
# Click log
## Definition
The click log is [S32](../capabilities/S32-product-search.md)'s store of recorded clicks on search results. Together with the [search query log](query-log.md), it is the data behind the per-query report in [`GET /admin/search/quality`](get-admin-search-quality.md). The click log is what gives that report its [click-through rate](click-through-rate.md) and [MRR](mrr.md). Rows expire after a fixed retention window. Writing to the log never blocks or fails a search.

## Example
1. A user searches `q=iphone` and gets a [`searchId`](search-id.md).
2. The user clicks the second result, and the client calls `POST /search/clicks` (`202`).
3. A click row is stored. The admin quality report for `iphone` then counts it in that query's click-through rate and MRR (row contents are illustrative).

## Known gaps
- The spec does not say what columns a click row holds or how a click is linked to its search (most likely through `searchId`, but this is not confirmed).
- The spec does not say what happens to a click when writing to the log fails. Logging failure (AS-75) has no test.
- The spec does not say how repeated clicks are deduplicated. Consumer idempotency (AS-72) has no test.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): R-15
- [click-through-rate](click-through-rate.md)
- [get-admin-search-quality](get-admin-search-quality.md)
- [image-position](image-position.md)
- [mrr](mrr.md)
- [post-search-clicks](post-search-clicks.md)
- [query-log](query-log.md)
- [search-result-clicked-event](search-result-clicked-event.md)
<!-- used-by:end -->
