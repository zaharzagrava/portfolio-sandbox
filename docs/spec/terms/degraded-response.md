---
id: degraded-response
title: degraded member
kind: term
status: draft
aliases: [catalog_timeout]
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# degraded member
## Definition
`degraded` is a member of the `GET /suggest` response body. It lists every [suggestion source](suggestion-source.md) that could not contribute to this answer. Failing sources never fail a valid request: the answer still returns `200` with whatever the healthy sources gave. A non-empty `degraded` makes the response [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store), so a [shared cache ↗](../sw-external-terms.md#shared-cache) does not keep a partial answer. When every source is healthy, `degraded` is an empty list.

## Example
```json
{ "prefix": "iph", "suggestions": [ /* query suggestions only */ ], "degraded": ["catalog_timeout"] }
```
The other values seen in the spec are `catalog_unavailable` (engine rejected or [circuit open ↗](../sw-external-terms.md#circuit-breaker)) and `query_index_unavailable` ([no snapshot loaded](suggest-snapshot.md)).

## Known gaps
- The spec does not give the full closed set of `degraded` values. Only `catalog_timeout`, `catalog_unavailable` and `query_index_unavailable` appear.
- The spec does not say what value is reported when the typo source fails, or whether it is reported at all.
- The spec does not say in what order several values are listed. The one example shows `["query_index_unavailable", "catalog_unavailable"]`.

## Used by
<!-- used-by:start -->
- [suggest-snapshot](suggest-snapshot.md)
- [suggestion-source](suggestion-source.md)
<!-- used-by:end -->
