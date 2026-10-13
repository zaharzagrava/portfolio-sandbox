---
id: query-suggestions
title: Query suggestions (autocomplete)
kind: term
status: draft
aliases: [suggestions]
defined_for: S33-autocomplete
rules_hash: 0f124ab7732a
---
# Query suggestions (autocomplete)
## Definition
Query suggestions are autocomplete entries taken from popular past searches. They are read from the in-memory [top-K trie ↗](../sw-external-terms.md#trie) built from a saved record of past searches. They are ordered by [distinct searchers](distinct-searchers.md) (most first), then by text ascending, so identical calls give [byte-identical](identical-registration-response.md) answers. [In the blend](suggestion-blend.md), queries get their own share of slots and come first. Their entries win when duplicates are removed against catalog and spelling-correction entries.

## Example
`iphone case` and `iphone cable` have the same searcher count. `GET /api/suggest?q=iph` lists `iphone cable` before `iphone case`, and repeating the call gives the same body (S33.B-02).

## Known gaps
- The spec does not give the JSON shape of one suggestion item. It only says entries are of kind `query` or `catalog`.
- The spec does not say whether the searcher count is exposed in the response.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-08
- [W02](../capabilities/W02-storefront-discovery.md): B-03
- [autocomplete-blocklist](autocomplete-blocklist.md)
- [distinct-searchers](distinct-searchers.md)
- [get-suggest](get-suggest.md)
- [identical-registration-response](identical-registration-response.md)
- [query-snapshot](query-snapshot.md)
- [search-box](search-box.md)
- [suggestion-blend](suggestion-blend.md)
- [typo-suggestion-source](typo-suggestion-source.md)
<!-- used-by:end -->
