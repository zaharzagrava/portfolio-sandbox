---
id: barrel-export
title: Domain barrel export
kind: term
status: draft
aliases: [barrel]
defined_for: S32-product-search
rules_hash: 1f0cc68e0a4e
---
# Domain barrel export
## Definition
The domain barrel is the single file through which a domain exposes its [public API](backend-api.md) to other domains. The search domain exports `ProductSearchService.search` through it, with the same visibility as the public route and a reduced set of options. The barrel must not export any [projector ↗](../sw-external-terms.md#projection), [consumer](event-consumer.md), logger or model. Keeping those internals out of the barrel stops other domains from coupling to them. That reason is design intent (not stated in the spec).

## Example
Another domain imports `ProductSearchService` from the search barrel and calls `search` with a `limit` of at most 20. It passes no [cursor](pagination-cursor.md) and no [facets](search-facets.md), and the logged event carries [`surface: "internal"`](search-surface.md). The search projector cannot be imported through the barrel.

## Known gaps
- The spec does not give the barrel's file path.
- The spec does not say whether [`ProductTitleSuggester`](product-title-suggester.md) is exported through the same barrel or wired some other way for S33.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-45, R-47
- [backend-api](backend-api.md)
- [check-boundaries](check-boundaries.md)
- [event-consumer](event-consumer.md)
- [pagination-cursor](pagination-cursor.md)
- [search-facets](search-facets.md)
- [shop-account](shop-account.md)
<!-- used-by:end -->
