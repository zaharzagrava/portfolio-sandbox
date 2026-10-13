---
id: relevance-boost
title: Relevance boosts
kind: term
status: draft
aliases: [boost, boosts]
defined_for: job-scheduler-lease
rules_hash: 260e289648ee
---
# Relevance boosts
## Definition
Relevance boosts are adjustments that move some products higher in [S32](../capabilities/S32-product-search.md) search results than plain text matching would put them. They are part of the S32 product search capability, alongside alternative words that count as matches for a query, [facets](search-facets.md) and [k-NN search ↗](../sw-external-terms.md#knn-search). The spec lists them but does not say which signals they use or how much weight each signal gets.

## Example
Illustrative only. Two products match the query "running shoes" equally well on text. A boost based on some product signal ranks one of them first. S32 also runs a job named [`search.refresh-popularity`](search-refresh-popularity.md), but the spec does not say that popularity feeds the boosts.

## Known gaps
- The spec does not say which signals drive relevance boosts, how they are weighted, or whether shops or admins can configure them.
- Not confirmed in the code: that `search.refresh-popularity` produces the data the boosts use. The connection is only suggested by the job's name.
- The spec does not say how often boost data is refreshed, so boosted results may be out of date by an unknown amount.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-07, B-04, B-11
- [business-score](business-score.md)
- [combined-business-multiplier](combined-business-multiplier.md)
- [search-facets](search-facets.md)
- [search-index](search-index.md)
- [search-refresh-popularity](search-refresh-popularity.md)
- [search-synonyms](search-synonyms.md)
- [search-total-order](search-total-order.md)
- [semantic-search](semantic-search.md)
- [sponsorship-event](sponsorship-event.md)
<!-- used-by:end -->
