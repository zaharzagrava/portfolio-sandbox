---
id: error-text-not-exposed
title: Error text not exposed
kind: term
status: draft
aliases: [not exposed]
defined_for: S33-autocomplete
rules_hash: c595688b9148
---
# Error text not exposed
## Definition
When the search engine behind [catalog completions](catalog-completions.md) rejects a call, the response does not include the engine's error message. The caller only sees the [source](suggestion-source.md) named in [`degraded`](degraded.md), as [`catalog_unavailable`](degraded-response.md), alongside the suggestions that other sources returned. Design intent (not stated in the spec): this avoids leaking internal details, such as hosts or query syntax, to anonymous callers.

## Example
The engine rejects with an internal error. The client still gets:
```json
{ "prefix": "iph", "suggestions": [ /* [query suggestions](query-suggestions.md) */ ], "degraded": ["catalog_unavailable"] }
```
No field contains the engine's message (S33.B-09).

## Known gaps
- The spec does not say whether the hidden error text is logged or counted elsewhere, for example in [`autocomplete_source_duration_seconds`](autocomplete-source-duration-seconds.md) or some other metric.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-09
- [catalog-completions](catalog-completions.md)
- [catalog-suggestion-source](catalog-suggestion-source.md)
- [health-check-up](health-check-up.md)
- [suggestion-source](suggestion-source.md)
<!-- used-by:end -->
