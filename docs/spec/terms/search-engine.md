---
id: search-engine
title: Search engine
kind: term
status: draft
aliases: [engine]
defined_for: S33-autocomplete
rules_hash: 75c5638447bd
---
# Search engine
## Definition
"The engine" is the [S32](../capabilities/S32-product-search.md) search back end that supplies [catalog completions](catalog-completions.md) through S32's [`ProductTitleSuggester`](product-title-suggester.md). Autocomplete treats it as an optional source that can fail. A timeout is reported as [`catalog_timeout`](degraded-response.md), and a rejection is reported as [`catalog_unavailable`](degraded-response.md). Repeated failures open the catalog [circuit breaker ↗](../sw-external-terms.md#circuit-breaker), so the engine is skipped for a while. Successful results are cached per normalised prefix, which keeps the engine from being called on every keystroke.

## Example
If the engine never answers, `q=iph` still returns query suggestions within the request budget:
```json
{ "prefix": "iph", "suggestions": [ ... ], "degraded": ["catalog_timeout"] }
```
That response carries `Cache-Control: no-store`.

## Known gaps
- The spec does not name the engine's product or technology. It only names S32's `ProductTitleSuggester`.
- The spec does not state the catalog source's own time budget. It only says the whole answer arrives within 250 ms when the engine hangs.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-05, B-08
- [catalog-completions](catalog-completions.md)
- [search-budget](search-budget.md)
- [search-unavailable-total](search-unavailable-total.md)
- [search-unavailable](search-unavailable.md)
- [shop-search-table](shop-search-table.md)
- [text-relevance](text-relevance.md)
<!-- used-by:end -->
