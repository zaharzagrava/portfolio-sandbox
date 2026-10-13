---
id: fuzzy-matching
title: Fuzzy matching
kind: term
status: draft
aliases: [fuzzy, typos]
defined_for: S32-product-search
rules_hash: a070c4180e35
---
# Fuzzy matching
## Definition
Fuzzy matching lets text search find products even when the caller misspells a word. A product that matches the query exactly always [ranks above](search-total-order.md) one that only matches fuzzily. Fuzzy matching has limits: a word that is too far from any product returns no items.

## Example
- `q=iphnoe` returns the iPhone case, and `q=aipods` returns AirPods.
- `q=xpone` returns `items: []`.

## Known gaps
- The spec does not say how many typos are tolerated (the [edit distance ↗](../sw-external-terms.md#edit-distance)) or whether this depends on word length.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-05
- [product-search-route](product-search-route.md)
- [search-total-order](search-total-order.md)
- [text-relevance](text-relevance.md)
- [zero-result-rate](zero-result-rate.md)
<!-- used-by:end -->
