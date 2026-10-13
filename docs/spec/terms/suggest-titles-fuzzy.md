---
id: suggest-titles-fuzzy
title: suggestTitlesFuzzy
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# suggestTitlesFuzzy
## Definition
`suggestTitlesFuzzy` is the typo-tolerant version of [`ProductTitleSuggester.suggestTitles`](product-title-suggester.md). It is part of the same [in-process port](in-process-port.md) that the search domain exports for S33. Use it when the caller's text may be misspelled. It uses [fuzzy matching](fuzzy-matching.md), so a title can still be suggested when the input does not exactly match it. Only the S33 capability uses it. Other domains should use [`ProductSearchService.search`](product-search-service.md) instead.

## Example
S33 needs title suggestions for text a user mistyped, such as `iphnoe` (illustrative). It calls `suggestTitlesFuzzy` in place of `suggestTitles`. The fuzzy variant can still return product titles that are close to the input.

## Known gaps
- The spec does not say whether `suggestTitlesFuzzy` follows the same rules as `suggestTitles`. Those rules are: visible products only, at most `size` titles (1 to 10), and [`SuggestionTimeoutError`](suggestion-timeout-error.md) when the signal aborts or the engine does not answer.
- The spec does not say how much of a typo it tolerates, or whether exact matches rank above fuzzy ones in its results.
- The spec does not say when S33 should call it instead of `suggestTitles`. For example, it does not say whether S33 calls it only after `suggestTitles` returns nothing.

## Used by
<!-- used-by:start -->
- [fuzzy-matching](fuzzy-matching.md)
- [in-process-port](in-process-port.md)
<!-- used-by:end -->
