---
id: get-suggest
title: GET /suggest
kind: term
status: draft
aliases: [/suggest]
defined_for: S33-autocomplete
rules_hash: 8a59e36114e5
---
# GET /suggest
## Definition
`GET /suggest` is the [autocomplete](query-suggestions.md) endpoint the search box calls after every keystroke. It is served under `/api/suggest`. It is anonymous, and every caller gets the same answer for the same input. It takes only `q` and `limit` and returns `{prefix, suggestions, degraded}`. The answer is a [suggestion blend](suggestion-blend.md) of [query suggestions](query-suggestion.md) and [catalog completions](catalog-completions.md). A failing or slow source never fails the request: the answer names it in [`degraded`](degraded.md) instead.

## Example
```
GET /api/suggest?q=IPH
→ 200 {"prefix": "iph", "suggestions": [ …query and catalog entries… ], "degraded": []}
Cache-Control: public, max-age=60, s-maxage=60
```
If the engine never answers, the same call returns only query suggestions, `degraded: ["catalog_timeout"]` and `Cache-Control: no-store`.

## Known gaps
- The spec does not give the JSON shape of a single entry in `suggestions`, such as its field names or how it marks its source.
- The spec does not say when the typo source is consulted or how many slots it gets in the blend.
- The spec does not say what the `429` problem+json body contains besides the `rate_limited` code and the `Retry-After` header.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): R-04
- [catalog-completions](catalog-completions.md)
- [query-suggestion](query-suggestion.md)
- [query-suggestions](query-suggestions.md)
- [search-box](search-box.md)
- [stale-response-discard](stale-response-discard.md)
- [suggestion-blend](suggestion-blend.md)
- [use-suggestions](use-suggestions.md)
<!-- used-by:end -->
