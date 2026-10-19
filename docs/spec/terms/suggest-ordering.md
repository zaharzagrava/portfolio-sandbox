---
id: suggest-ordering
title: Suggest ordering
kind: term
status: draft
aliases: [tie-break]
defined_for: S33-autocomplete
rules_hash: a4e213d1b9d1
---
# Suggest ordering
## Definition
Suggest ordering is the fixed order of entries in an autocomplete answer. Query suggestions are sorted by [distinct searchers](distinct-searchers.md), highest first. Ties are sorted by text in ascending order. Across sources, [the blend](suggestion-blend.md) puts entries in the order query, catalog, [typo](typo-suggestion-source.md), and the first occurrence wins when texts duplicate. Because the order is [total](search-total-order.md), two identical calls give byte-identical answers. This lets a [shared cache ↗](../sw-external-terms.md#shared-cache) safely hold the answer.

## Example
`iphone case` and `iphone cable` have the same number of searchers. A call with `q=iph` returns `iphone cable` before `iphone case`, and a second call returns exactly the same bytes.

## Known gaps
- The spec does not say how "text ascending" compares strings (for example code-point order or a locale collation).
- The spec does not say how catalog or typo entries are ordered among themselves.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-02
- [W02](../capabilities/W02-storefront-discovery.md): B-03
- [distinct-searchers](distinct-searchers.md)
- [exact-top-k](exact-top-k.md)
- [search-total-order](search-total-order.md)
- [shop-leaderboard](shop-leaderboard.md)
- [shop-rank](shop-rank.md)
- [suggestion-blend](suggestion-blend.md)
- [typo-suggestion-source](typo-suggestion-source.md)
- [use-suggestions](use-suggestions.md)
<!-- used-by:end -->
