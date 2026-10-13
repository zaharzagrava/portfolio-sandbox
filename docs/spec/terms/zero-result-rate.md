---
id: zero-result-rate
title: Zero-result rate
kind: term
status: draft
aliases: [zeroresultrate]
defined_for: S32-product-search
rules_hash: 7eb5b9b822b1
---
# Zero-result rate
## Definition
The zero-result rate is the share of searches for one query that returned no items. It is one of the figures reported for each query, alongside [click-through rate](click-through-rate.md) and [MRR](mrr.md). A high value tends to mean missing products, a missing [synonym](search-synonyms.md), or a typo that [fuzzy matching](fuzzy-matching.md) cannot fix. Using it to spot these problems is design intent (not stated in the spec).

## Example
`q=xpone` returns [`items: []`](search-items.md) (S32.B-02), so every search for it counts as a zero-result search. If `xpone` was searched 10 times and all 10 returned nothing, its zero-result rate is 1.0. The numbers in this example are illustrative.

## Known gaps
- The spec does not say whether searches whose [filters](search-filters.md) removed every item count as zero-result searches. It also does not say whether [browse mode](browse-mode.md) or [semantic mode](search-mode.md) searches count.
- The spec does not say whether a [`503 search_unavailable`](search-unavailable.md) answer or a [degraded answer](degraded.md) counts as a zero-result search.
- The spec does not give the exact formula or the time window the rate is measured over.

## Used by
<!-- used-by:start -->
- [browse-mode](browse-mode.md)
- [click-through-rate](click-through-rate.md)
- [degraded](degraded.md)
- [fuzzy-matching](fuzzy-matching.md)
- [get-admin-search-quality](get-admin-search-quality.md)
- [mrr](mrr.md)
- [redacted-query](redacted-query.md)
- [search-filters](search-filters.md)
- [search-mode](search-mode.md)
- [search-quality-report](search-quality-report.md)
- [search-synonyms](search-synonyms.md)
<!-- used-by:end -->
