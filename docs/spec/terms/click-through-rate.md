---
id: click-through-rate
title: Click-through rate
kind: term
status: draft
aliases: [ctr]
defined_for: S32-product-search
rules_hash: 265ca6dc7941
---
# Click-through rate
## Definition
Click-through rate is the share of searches for a query where the user clicked at least one result. [S32](../capabilities/S32-product-search.md) calculates it per query and reports it in [`GET /admin/search/quality`](get-admin-search-quality.md). It comes from the [search query log](query-log.md) joined with the record of which results users clicked. The likely join key is [`searchId`](search-id.md), which is design intent (not stated in the spec). A low rate for a common query suggests the results for it are not useful.

## Example
Over a period, the query `iphone` ran 200 times and 120 of those searches got a click through [`POST /search/clicks`](post-search-clicks.md). The click-through rate for `iphone` is 120 / 200 = 0.6. (Numbers are illustrative.)

## Known gaps
- The spec does not say the exact formula: whether it counts searches with at least one click, or total clicks divided by searches.
- The spec does not say the time window the rate covers. The logs it is built from expire after their retention window.

## Used by
<!-- used-by:start -->
- [click-log](click-log.md)
- [get-admin-search-quality](get-admin-search-quality.md)
- [post-search-clicks](post-search-clicks.md)
- [query-log](query-log.md)
- [search-id](search-id.md)
- [search-quality-report](search-quality-report.md)
- [search-result-clicked-event](search-result-clicked-event.md)
- [zero-result-rate](zero-result-rate.md)
<!-- used-by:end -->
