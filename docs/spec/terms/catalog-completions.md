---
id: catalog-completions
title: Catalog completions
kind: term
status: draft
aliases: [catalog completion, completions]
defined_for: S33-autocomplete
rules_hash: 7108e4818c71
---
# Catalog completions
## Definition
Catalog completions are suggestions made from the titles of visible products that start with the typed prefix. They come from the product catalog, and they appear in the response next to suggestions drawn from past searches. They are only requested for prefixes above a minimum length. The list of banned suggestions is applied to them when the response is returned. Like every `200`, the combined answer is the same for every caller, because it does not vary on credentials.

## Example
The product `Cheap iPhone Stand` appears as a catalog completion for `q=cheap`. Once `cheap` is added to the blocklist and the service reloads it, the product no longer appears. This takes effect [without a new build](suggestion-build.md).

## Known gaps
- The spec does not say whether completions are returned with the product's original casing or as normalised text.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-11, B-20
- [autocomplete-cache-key](autocomplete-cache-key.md)
- [autocomplete-pointer](autocomplete-pointer.md)
- [autocomplete-q-parameter](autocomplete-q-parameter.md)
- [blended-suggestions](blended-suggestions.md)
- [blocklist-reload](blocklist-reload.md)
- [catalog-suggestion-source](catalog-suggestion-source.md)
- [catalog-title-source-adapter](catalog-title-source-adapter.md)
- [error-text-not-exposed](error-text-not-exposed.md)
- [get-suggest](get-suggest.md)
- [product-title-suggester](product-title-suggester.md)
- [query-suggestion](query-suggestion.md)
- [readiness](readiness.md)
- [search-engine](search-engine.md)
- [serve-time](serve-time.md)
- [serving-node](serving-node.md)
- [slot-budget](slot-budget.md)
- [suggestion-blend](suggestion-blend.md)
- [suggestion-blocklist](suggestion-blocklist.md)
- [suggestion-build](suggestion-build.md)
- [typo-suggestion-source](typo-suggestion-source.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
