---
id: suggestion
title: Suggestion
kind: term
status: draft
aliases: [suggestions]
defined_for: S33-autocomplete
rules_hash: 55f449597100
---
# Suggestion
## Definition
A suggestion is one entry in the `suggestions` array of a [`GET /suggest`](get-suggest.md) answer. Each entry comes from one source: a query (a popular past search), a catalog title (a visible product), or a typo-corrected title. [The blend](suggestion-blend.md) removes duplicates on [normalised text](normalised-text.md), and the first occurrence wins in the order query, catalog, typo. [The blocklist](suggestion-blocklist.md) is applied to every suggestion at [serve time](serve-time.md).

## Example
For `q=iph`, the list might hold the query suggestion `iphone case` followed by a catalog title for a visible iPhone product. Both entries are illustrative.

## Known gaps
- The spec does not give the JSON shape of a single suggestion entry, for example its field names or how it marks its source.
- The spec does not say when [the typo source](typo-suggestion-source.md) is consulted or how many slots it gets.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-06
- [normalised-text](normalised-text.md)
- [serve-time](serve-time.md)
- [suggestion-blend](suggestion-blend.md)
- [suggestion-blocklist](suggestion-blocklist.md)
- [typo-suggestion-source](typo-suggestion-source.md)
<!-- used-by:end -->
