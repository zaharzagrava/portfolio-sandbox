---
id: catalog-title-source-adapter
title: CatalogTitleSourceAdapter
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# CatalogTitleSourceAdapter
## Definition
`CatalogTitleSourceAdapter` is the [infrastructure adapter ↗](../sw-external-terms.md#infrastructure-adapter) that connects [S33](../capabilities/S33-autocomplete.md) to [S32](../capabilities/S32-product-search.md)'s [`ProductTitleSuggester`](product-title-suggester.md). It is the [catalog suggestion source](catalog-suggestion-source.md) in the [suggestion blend](suggestion-blend.md), and it produces [catalog completions](catalog-completions.md). It returns titles of [visible products](search-visibility.md) only, and only once the [reduced prefix](reduced-prefix.md) reaches a minimum length. It lives at `packages/backend/libs/domains/discovery/infra/catalog-title-source-adapter.ts`.

## Example
For `q=IPH`, the adapter asks `ProductTitleSuggester` for titles that complete `iph`. Visible iPhone titles come back as `catalog` entries. If the engine rejects the call, the answer still returns `200` with [`degraded: ["catalog_unavailable"]`](degraded-marker.md).

## Known gaps
- Not confirmed in the code: whether this adapter or another layer applies the per-prefix catalog cache, the [circuit breaker ↗](../sw-external-terms.md#circuit-breaker) and the catalog timeout. The rules state that these exist but do not say where they run.
- The spec does not say how many titles the adapter asks `ProductTitleSuggester` for, or what shape that call takes.

## Used by
<!-- used-by:start -->
- [catalog-completions](catalog-completions.md)
- [catalog-suggestion-source](catalog-suggestion-source.md)
- [reduced-prefix](reduced-prefix.md)
- [search-visibility](search-visibility.md)
- [suggestion-blend](suggestion-blend.md)
<!-- used-by:end -->
