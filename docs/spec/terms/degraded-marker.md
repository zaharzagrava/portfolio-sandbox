---
id: degraded-marker
title: degraded marker
kind: term
status: draft
aliases: [query_index_unavailable]
defined_for: S33-autocomplete
rules_hash: 6e8780f9058a
---
# degraded marker
## Definition
[`degraded`](degraded.md) is an array in every [`/suggest`](get-suggest.md) response. It names each [source](suggestion-source.md) that could not contribute to the answer. A source that fails or times out never fails a valid request. The request still returns `200`, and the missing source is listed here, without exposing any error text. When `degraded` is not empty, the response carries [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store), so [shared caches ↗](../sw-external-terms.md#shared-cache) do not keep a partial answer.

## Example
These are the values seen in the spec:
```json
{ "prefix": "iph", "suggestions": [], "degraded": ["query_index_unavailable", "catalog_unavailable"] }
```
The other value seen is `catalog_timeout`, returned when the engine never answers in time. `catalog_unavailable` also appears while the [catalog circuit breaker ↗](../sw-external-terms.md#circuit-breaker) is open.

## Known gaps
- The spec does not say whether these three values are the complete, closed set. In particular, it names no value for the typo-fallback source.
- The spec does not say whether the order of entries in `degraded` is guaranteed.

## Used by
<!-- used-by:start -->
- [lexical-search](lexical-search.md)
- [suggestion-source](suggestion-source.md)
<!-- used-by:end -->
