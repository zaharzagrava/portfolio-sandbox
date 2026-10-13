---
id: mrr
title: MRR (mean reciprocal rank)
kind: term
status: draft
aliases: [mean reciprocal rank]
defined_for: S32-product-search
rules_hash: 265ca6dc7941
---
# MRR (mean reciprocal rank)
## Definition
MRR (mean reciprocal rank) measures how high in the results the clicked product was. For each search, take 1 divided by the position of the clicked result, then average that over all searches for the query. A value near 1 means users usually click the top result. [S32](../capabilities/S32-product-search.md) reports MRR per query in [`GET /admin/search/quality`](get-admin-search-quality.md), using the search query and the recorded clicks on search results.

## Example
Three searches for `airpods` got clicks at positions 1, 2 and 4. MRR = (1/1 + 1/2 + 1/4) / 3 ≈ 0.58. (Numbers are illustrative.)

## Known gaps
- The spec does not say which click counts when one search has several clicks (first click or best rank), or how searches with no click are scored.
- The spec does not say whether the position is counted within the page or across all pages reached through [`nextCursor`](pagination-cursor.md).

## Used by
<!-- used-by:start -->
- [click-log](click-log.md)
- [get-admin-search-quality](get-admin-search-quality.md)
- [post-search-clicks](post-search-clicks.md)
- [search-id](search-id.md)
- [search-quality-report](search-quality-report.md)
- [search-result-clicked-event](search-result-clicked-event.md)
- [zero-result-rate](zero-result-rate.md)
<!-- used-by:end -->
