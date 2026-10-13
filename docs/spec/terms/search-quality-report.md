---
id: search-quality-report
title: Search quality report
kind: term
status: draft
aliases: [search quality]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# Search quality report
## Definition
The search quality report is the response of [`GET /admin/search/quality`](get-admin-search-quality.md). It lists each search query with its number of searches, [click-through rate](click-through-rate.md), [MRR](mrr.md) and [zero-result rate](zero-result-rate.md). Like every [S32](../capabilities/S32-product-search.md) admin endpoint, it requires an administrator. The figures most likely come from the [search log](search-log.md) and click log that S32 owns. The spec does not say this directly. Operators use the report to find queries that give poor results and to tune synonyms or boosts. That use is design intent (not stated in the spec).

## Example
```
GET /admin/search/quality
→ 200 [ { "q": "iphone", "searches": 200, "clickThroughRate": 0.6, "mrr": 0.58, "zeroResultRate": 0.0 } ]
```
All field names and values here are illustrative. The spec gives no response shape.

## Known gaps
- The spec does not say the response shape, the time range covered, or whether the report supports paging or filters.
- The spec does not say how query text is normalised before grouping. For example, it does not say whether `iPhone` and `iphone` count as one query.
- Not confirmed in the code: the report is computed from the search log and click log. The facts list no code excerpt for this endpoint.

## Used by
<!-- used-by:start -->
- [click-through-rate](click-through-rate.md)
- [get-admin-search-quality](get-admin-search-quality.md)
- [mrr](mrr.md)
- [search-log](search-log.md)
- [zero-result-rate](zero-result-rate.md)
<!-- used-by:end -->
