---
id: suggestion-source
title: Suggestion source
kind: term
status: draft
aliases: [source, source failure, sources]
defined_for: S33-autocomplete
rules_hash: 1d5cfdff1c5b
---
# Suggestion source
## Definition
A suggestion source is one of the independent providers that the [suggestion blend](suggestion-blend.md) combines. The three sources are popular past queries taken from the [loaded snapshot](suggest-snapshot.md), the catalog, and typo correction. Each source has its own limit on how much time and work it may use. A failing or slow source never fails a valid request: it is left out and named in [`degraded`](degraded.md). One shared list of banned suggestions applies to every suggestion from every source.

## Example
With no snapshot loaded and a failing engine, `GET /api/suggest?q=iph` returns:
```json
{ "prefix": "iph", "suggestions": [], "degraded": ["query_index_unavailable", "catalog_unavailable"] }
```
The response is `200` with `Cache-Control: no-store`.

## Known gaps
- The spec does not list every possible `degraded` value. Only `query_index_unavailable`, `catalog_unavailable` and `catalog_timeout` appear, and none is given for the typo source.
- The spec does not say the per-source time budgets. "budgets" is named as configuration, but no values are given.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-12, B-05
- [autocomplete-source-duration-seconds](autocomplete-source-duration-seconds.md)
- [degraded-marker](degraded-marker.md)
- [degraded-response](degraded-response.md)
- [degraded](degraded.md)
- [error-text-not-exposed](error-text-not-exposed.md)
- [normalised-text](normalised-text.md)
- [query-index](query-index.md)
- [search-budget](search-budget.md)
- [slot-budget](slot-budget.md)
- [suggest-prefix](suggest-prefix.md)
- [suggest-snapshot](suggest-snapshot.md)
- [suggestion-blend](suggestion-blend.md)
- [suggestion-blocklist](suggestion-blocklist.md)
- [typo-suggestion-source](typo-suggestion-source.md)
<!-- used-by:end -->
