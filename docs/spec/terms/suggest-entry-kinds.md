---
id: suggest-entry-kinds
title: Suggestion entry kinds
kind: term
status: draft
aliases: [query and catalog entries]
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# Suggestion entry kinds
## Definition
Each suggestion returned by [`GET /suggest`](get-suggest.md) has a kind that names the source it came from. A `query` entry is a popular past search taken from the [loaded snapshot](suggest-snapshot.md). A [`catalog` entry](catalog-suggestion-source.md) is a visible product title completed through [S32](../capabilities/S32-product-search.md)'s [`ProductTitleSuggester`](product-title-suggester.md). The page also describes [typo-corrected titles](typo-suggestion-source.md) as a third source of the [blend](suggestion-blend.md). When two entries have the same [normalised text](normalised-text.md), the blend keeps only the first one, in the order query, catalog, typo.

## Example
`GET /api/suggest?q=IPH` returns `prefix: "iph"` and a blended list. The list could hold a `query` entry `iphone case` and a `catalog` entry for a visible iPhone product title (illustrative).

## Known gaps
- The spec does not say which response field carries the kind, or the exact shape of a suggestion object.
- The spec does not say whether typo-corrected entries get a kind value of their own, or what that value is.

## Used by
<!-- used-by:start -->
- [catalog-suggestion-source](catalog-suggestion-source.md)
- [normalised-text](normalised-text.md)
- [query-suggestion](query-suggestion.md)
- [suggest-snapshot](suggest-snapshot.md)
- [suggestion-blend](suggestion-blend.md)
- [typo-suggestion-source](typo-suggestion-source.md)
<!-- used-by:end -->
