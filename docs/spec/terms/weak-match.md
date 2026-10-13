---
id: weak-match
title: Weak match
kind: term
status: draft
aliases: [exact match, exact text match]
defined_for: S32-product-search
rules_hash: 6dea31287505
---
# Weak match
## Definition
A weak match is a product that matches the search text only loosely, so its text relevance is low. Typical cases are a fuzzy match, or a match only in a low-weight field such as tags. Relevance boosts cannot lift a weak match above an exact match, because the combined business multiplier is capped. This guarantee is the reason the cap exists (S32.R-07).

## Example
`GET /products/search?q=iphone`: product A has "iPhone" in its title and no boosts. Product B mentions the word only loosely, so it is a weak match, but it has every boost: in stock, high rating, popular, a `PRO` plan and `sponsored: true`. Product A still ranks above B (S32.R-07, AS-06, AS-86).

## Known gaps
- The spec does not say what makes a match "weak". It gives no score threshold and does not say whether every fuzzy or tags-only match counts.
- The spec does not say how big the gap between an exact match and a weak match must be for the multiplier cap to guarantee the ordering.
- Not confirmed in the code: the facts include no code excerpt for the search service, so this ranking guarantee is backed only by the tests for AS-06 and AS-86.

## Used by
<!-- used-by:start -->
- [combined-business-multiplier](combined-business-multiplier.md)
<!-- used-by:end -->
