---
id: suggestion-timeout-error
title: SuggestionTimeoutError
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# SuggestionTimeoutError
## Definition
`SuggestionTimeoutError` is the error that [`ProductTitleSuggester.suggestTitles`](product-title-suggester.md) throws when it cannot finish. It is thrown in two cases: the caller's [abort signal ↗](../sw-external-terms.md#abort-signal) fires, or the [search engine](search-engine.md) does not answer. With one named error, the caller (S33) can tell "no answer in time" apart from "no matching titles".

## Example
S33 calls `suggestTitles` with a `size` of 5 (illustrative) and an abort signal. The signal fires before the engine answers, so the call rejects with `SuggestionTimeoutError` instead of returning a partial list.

## Known gaps
- The spec does not say how long the suggester waits before it treats the engine as not answering, or whether it only relies on the caller's signal.
- The spec does not say whether [`suggestTitlesFuzzy`](suggest-titles-fuzzy.md) fails with the same error.

## Used by
<!-- used-by:start -->
- [search-engine](search-engine.md)
<!-- used-by:end -->
