---
id: normalised-text
title: Normalised text
kind: term
status: draft
aliases: [normalised, normalized text]
defined_for: S33-autocomplete
rules_hash: 23f9a1f80e45
---
# Normalised text
## Definition
Normalised text is the form of a suggestion's text that the [suggestion blend](suggestion-blend.md) compares to find duplicates. When two [sources](suggestion-source.md) offer suggestions with the same normalised text, only the first one is kept. Sources are taken in a fixed order: past queries first, then catalog items, then typo corrections. So a popular past query wins over a matching product title. This keeps the list free of [entries](cache-entry.md) that look like repeats to the buyer.

## Example
The query source offers `iphone case`, and the catalog source offers a product titled `iPhone Case` (illustrative). If both normalise to `iphone case`, only the query suggestion stays in the list.

## Known gaps
- The spec does not say which steps normalise suggestion text. It may be the same reduction used for [`q`](autocomplete-q-parameter.md) ([the reduced prefix](reduced-prefix.md)), but that is not confirmed.
- The spec does not say whether the returned suggestion shows the original text or the normalised text.

## Used by
<!-- used-by:start -->
- [autocomplete-q-parameter](autocomplete-q-parameter.md)
- [blended-suggestions](blended-suggestions.md)
- [cache-entry](cache-entry.md)
- [reduced-prefix](reduced-prefix.md)
- [stale-response-discard](stale-response-discard.md)
- [suggest-entry-kinds](suggest-entry-kinds.md)
- [suggestion-blend](suggestion-blend.md)
- [suggestion-source](suggestion-source.md)
- [suggestion](suggestion.md)
<!-- used-by:end -->
