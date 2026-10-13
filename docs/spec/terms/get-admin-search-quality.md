---
id: get-admin-search-quality
title: GET /admin/search/quality
kind: term
status: draft
aliases: [/admin/search/quality]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# GET /admin/search/quality
## Definition
`GET /admin/search/quality` is an admin endpoint that returns a [search quality report](search-quality-report.md), broken down per query. For each query it gives the number of searches, the [click-through rate](click-through-rate.md), [MRR](mrr.md) and the [zero-result rate](zero-result-rate.md). The data comes from the search query and [click logs](click-log.md), which [S32](../capabilities/S32-product-search.md) owns. Like every S32 admin endpoint, it requires the administrator role.

## Example
```
GET /admin/search/quality
→ 200 [ { "q": "iphone", "searches": 200, "clickThroughRate": 0.6, "mrr": 0.58, "zeroResultRate": 0.0 } ]
```
(The field names and values are illustrative. The spec gives no response shape.)

## Known gaps
- The spec does not say the response shape, the time range covered, or whether the report supports paging or filters.
- The spec does not say how query text is normalised before grouping, for example whether `iPhone` and `iphone` count as the same query.

## Used by
<!-- used-by:start -->
- [click-log](click-log.md)
- [click-through-rate](click-through-rate.md)
- [mrr](mrr.md)
- [search-quality-report](search-quality-report.md)
- [zero-result-rate](zero-result-rate.md)
<!-- used-by:end -->
