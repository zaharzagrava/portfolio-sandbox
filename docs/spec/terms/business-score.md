---
id: business-score
title: Business score
kind: term
status: draft
aliases: [ranking score]
defined_for: S32-product-search
rules_hash: 918a37036f27
---
# Business score
## Definition
The business score is a ranking value that reflects commercial signals for a product rather than text match. The signals are stock, rating, popularity, [plan tier](plan-limit.md) and [sponsorship](sponsorship-event.md). When a search has no [`q`](autocomplete-q-parameter.md), the mode is [`browse`](browse-mode.md) and items are ordered by business score, highest first, with `id` ascending breaking ties. In text searches, these signals act as a capped multiplier on top of text relevance, so an exact text match still outranks a weak match that has every boost (see [relevance boosts](relevance-boost.md)).

## Example
`GET /products/search` with no `q` returns `mode: "browse"`. Two products are identical except that one shop is on the `PRO` plan. The `PRO` product appears first.

## Known gaps
- The spec does not say how the signals are weighted or combined into one score.
- The spec does not say whether the browse-mode business score is the same value as the "[combined business multiplier](combined-business-multiplier.md)" that S32.R-07 caps.
- The [facets](search-facets.md) (AS-15 to AS-17) and semantic modes have no tests, so it is unproven how the business score behaves there.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): B-03, B-04
- [S34](../capabilities/S34-recommendations.md): R-17
- [S35](../capabilities/S35-trending.md): B-01
- [browse-mode](browse-mode.md)
- [combined-business-multiplier](combined-business-multiplier.md)
- [field-weights](field-weights.md)
- [plan-limit](plan-limit.md)
- [relevance-boost](relevance-boost.md)
- [search-facets](search-facets.md)
- [search-mode](search-mode.md)
- [sponsorship-event](sponsorship-event.md)
- [text-relevance](text-relevance.md)
<!-- used-by:end -->
