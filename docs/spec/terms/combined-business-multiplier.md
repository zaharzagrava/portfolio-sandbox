---
id: combined-business-multiplier
title: Combined business multiplier
kind: term
status: draft
aliases: [capped multiplier]
defined_for: S32-product-search
rules_hash: 3cf8322dbcc6
---
# Combined business multiplier
## Definition
The combined business multiplier is a single factor applied to a product's [text relevance](text-relevance.md) in a text search. It merges the [relevance boosts](relevance-boost.md) (stock, rating, popularity, [plan tier](plan-limit.md), [sponsorship](sponsorship-event.md)) into one value. A rule keeps it inside a fixed range, so it can raise a product's text score but never lower it. The cap makes sure text relevance always wins: an exact text match outranks a [weak match](weak-match.md) even when the weak match has every boost.

## Example
`GET /products/search?q=iphone`: product A matches "iphone" exactly and has no boosts, so its multiplier is 1. Product B is a weak match with every boost: stock, a high rating, popularity, a `PRO` plan and `sponsored: true`. Its multiplier is held at the cap of 4. Product A still ranks above B (S32.R-07, AS-06, AS-86).

## Known gaps
- The spec does not say how the individual signals are weighted or combined (for example, multiplied or added) to produce the multiplier.
- The spec does not say how large the gap between an "exact" match and a "weak" match must be for the cap to guarantee the ordering.
- Not confirmed in the code: the facts include no code excerpt for the search service, so the [clamp](clamping.md) to the allowed range has not been checked in source.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-07
- [browse-mode](browse-mode.md)
- [business-score](business-score.md)
- [clamping](clamping.md)
- [plan-limit](plan-limit.md)
- [relevance-boost](relevance-boost.md)
- [search-ranking-signals](search-ranking-signals.md)
- [sponsorship-event](sponsorship-event.md)
- [text-relevance](text-relevance.md)
- [weak-match](weak-match.md)
<!-- used-by:end -->
