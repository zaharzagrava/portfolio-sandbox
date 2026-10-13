---
id: field-weights
title: Field weights
kind: term
status: draft
aliases: [field weight]
defined_for: S32-product-search
rules_hash: 08dce371287e
---
# Field weights
## Definition
Field weights decide how much a [text match](search-query-sanitisation.md) counts, based on which product field it is found in. The order from strongest to weakest is title, brand, description, tags. So a word found in a title [ranks the product higher](business-score.md) than the same word found only in its tags. Design intent (not stated in the spec): the title and brand best describe what the product is.

## Example
For [`q=iphone`](autocomplete-q-parameter.md), a product with "iPhone" in its title ranks above a product that has "iphone" only as a tag. Both products are illustrative.

## Known gaps
- The spec does not say the actual weight values, only their order.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-05
- [business-score](business-score.md)
- [lexical-search](lexical-search.md)
- [search-query-sanitisation](search-query-sanitisation.md)
- [text-relevance](text-relevance.md)
<!-- used-by:end -->
