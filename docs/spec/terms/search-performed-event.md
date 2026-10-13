---
id: search-performed-event
title: search.performed event
kind: term
status: draft
aliases: [search.performed]
defined_for: S32-product-search
rules_hash: b4febe611455
---
# search.performed event
## Definition
`search.performed` is an event that [S32](../capabilities/S32-product-search.md) emits. It is one of S32's three published events, next to [`search.result_clicked`](search-result-clicked-event.md) and `search.reindex_completed`. It most likely marks each answered search so the [search query log](query-log.md) and other consumers can record it. That is design intent (not stated in the spec). Logging never blocks or fails a search, so a search still succeeds if this record cannot be written.

## Example
An anonymous caller sends `GET /products/search?q=iphone` and gets `200` with a [`searchId`](search-id.md). S32 then emits `search.performed` for that search. (The event payload is not specified. Emitting once per answered search is design intent.)

## Known gaps
- The spec does not say the event payload, for example whether it carries `searchId`, the query text, the result count or caller identity.
- The spec does not say whether the event is emitted for every page fetched through [`nextCursor`](pagination-cursor.md), for shop search, or for failed searches.
- The spec does not say who consumes it. S32's own consumer list includes `search.result_clicked` but not `search.performed`.

## Used by
<!-- used-by:start -->
- [query-log](query-log.md)
- [search-surface](search-surface.md)
<!-- used-by:end -->
