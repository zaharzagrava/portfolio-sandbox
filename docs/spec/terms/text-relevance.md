---
id: text-relevance
title: Text relevance
kind: term
status: draft
aliases: [text score]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# Text relevance
## Definition
Text relevance is the score the [search engine](search-engine.md) gives a product for how well its text matches the [`q`](autocomplete-q-parameter.md) of a text search. It tolerates typos, but an exact match always scores above a [fuzzy](fuzzy-matching.md) one. [Field weights](field-weights.md) decide how much each field counts: title first, then brand, description and tags. Business factors can scale this score up but never lower it, and a cap on them keeps text relevance as the main ranking signal. In [browse mode](browse-mode.md) there is no `q`, so text relevance plays no part and items follow the [business score](business-score.md).

## Example
`GET /products/search?q=iphone`: a product with "iPhone" in its title gets higher text relevance than one that mentions "iPhone" only in its tags. `q=iphnoe` still finds the iPhone case through fuzzy matching, but with lower text relevance than an exact "iphone" match would get (S32.R-05, AS-02, AS-03).

## Known gaps
- The spec does not say how the search engine calculates the score, or how much fuzzy matches are penalised compared with exact ones.
- The spec does not say whether a synonym match (synonyms apply at search time) scores the same as a literal match.
- Not confirmed in the code: the facts include no code excerpt for the search service, so the field weights and the exact-over-fuzzy ordering have not been checked in source.

## Used by
<!-- used-by:start -->
- [browse-mode](browse-mode.md)
- [business-score](business-score.md)
- [combined-business-multiplier](combined-business-multiplier.md)
- [field-weights](field-weights.md)
- [fuzzy-matching](fuzzy-matching.md)
- [search-engine](search-engine.md)
<!-- used-by:end -->
