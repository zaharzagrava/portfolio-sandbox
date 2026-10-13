---
id: catalog-suggestion-source
title: Catalog suggestion source
kind: term
status: draft
aliases: [catalog]
defined_for: S33-autocomplete
rules_hash: 8fd46a9a47e9
---
# Catalog suggestion source
## Definition
The catalog suggestion source supplies the [catalog completions](catalog-completions.md) to the [suggestion blend](suggestion-blend.md). It is implemented by `CatalogTitleSourceAdapter`, which calls [S32](../capabilities/S32-product-search.md)'s `[ProductTitleSuggester](product-title-suggester.md)`. It only asks for prefixes above a minimum length, and it caches results per normalised prefix. A [circuit breaker ↗](../sw-external-terms.md#circuit-breaker) (`CatalogCircuit`) guards it, so a slow or failing search engine is skipped and reported in [`degraded`](degraded.md). A failed or timed-out call isn't cached.

## Example
The engine never answers. `GET /api/suggest?q=iph` still returns `200` within 250 ms with only query suggestions, `degraded: ["catalog_timeout"]` and [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store). If the engine rejects instead, the answer carries `degraded: ["catalog_unavailable"]` and the [error text is not exposed](error-text-not-exposed.md).

## Known gaps
- Not confirmed in the code: the timeout value inside the adapter. 250 ms comes from behavior S33.B-08, not from a named configuration key.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-09
- [catalog-completions](catalog-completions.md)
- [catalog-title-source-adapter](catalog-title-source-adapter.md)
- [error-text-not-exposed](error-text-not-exposed.md)
- [suggest-entry-kinds](suggest-entry-kinds.md)
- [suggest-limit](suggest-limit.md)
- [suggestion-blend](suggestion-blend.md)
<!-- used-by:end -->
