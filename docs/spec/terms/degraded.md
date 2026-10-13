---
id: degraded
title: degraded
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# degraded
## Definition
`degraded` is a list in every [`GET /suggest`](get-suggest.md) response. It names each [suggestion source](suggestion-source.md) that could not contribute to that answer. A failing or slow source never fails a valid request. The answer still returns `200` with whatever the healthy sources gave, and the missing source is recorded here. A response with a non-empty `degraded` carries [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store), so a partial answer is never shared from a cache.

## Example
The engine never answers, so the catalog source times out, but the [query index](query-index.md) works:
```json
{ "prefix": "iph", "suggestions": [ /* query entries only */ ], "degraded": ["catalog_timeout"] }
```
Other values in the facts: `catalog_unavailable` (the engine rejects, or the [circuit breaker ↗](../sw-external-terms.md#circuit-breaker) is open) and `query_index_unavailable` (no [snapshot](suggest-snapshot.md) is loaded).

## Known gaps
- The spec does not say whether the typo-fallback source has its own `degraded` value, or what happens to the list when that source fails.
- The spec does not say how entries are ordered when several sources fail. The only example shows `["query_index_unavailable", "catalog_unavailable"]`.
- The spec does not give the full closed set of allowed values. It shows only the three listed above.

## Used by
<!-- used-by:start -->
- [page-upstream-sections](page-upstream-sections.md)
- [query-index](query-index.md)
- [search-mode](search-mode.md)
- [suggest-snapshot](suggest-snapshot.md)
- [suggestion-source](suggestion-source.md)
- [zero-result-rate](zero-result-rate.md)
<!-- used-by:end -->
