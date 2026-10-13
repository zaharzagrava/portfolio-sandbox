---
id: search-surface
title: surface (search event member)
kind: term
status: draft
aliases: [surface: "internal"]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# surface (search event member)
## Definition
`surface` is a member of the [`search.performed` event](search-performed-event.md). It records which entry point ran the search. A search that comes through [`ProductSearchService.search`](product-search-service.md) from another domain carries `surface: "internal"`. The member has to parse with the [event contract](event-definition.md) in `packages/contracts`, the same as every other member of the event.

## Example
A search made by another domain through the [in-process port](in-process-port.md) emits an event like this one (values other than `surface` are illustrative):
```json
{ "searchId": "…", "query": "running shoes", "results": 12, "mode": "lexical", "degraded": [], "surface": "internal" }
```

## Known gaps
- The spec does not say which other `surface` values exist. For example, it does not name a value for `GET /products/search` or for [`GET /shops/:shopId/products/search`](shop-product-search-route.md).
- The spec does not say whether the [search quality report](search-quality-report.md) or any other consumer filters or groups results by `surface`.

## Used by
<!-- used-by:start -->
- [event-definition](event-definition.md)
- [in-process-port](in-process-port.md)
- [search-performed-event](search-performed-event.md)
- [search-quality-report](search-quality-report.md)
<!-- used-by:end -->
