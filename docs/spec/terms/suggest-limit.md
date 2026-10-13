---
id: suggest-limit
title: Suggest limit parameter
kind: term
status: draft
aliases: [limit]
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# Suggest limit parameter
## Definition
`limit` is the optional query parameter of [`GET /suggest`](get-suggest.md) that caps how many suggestions come back. It must be an integer within the allowed range. Any other value gives `400` [problem+json ↗](../sw-external-terms.md#problem-json). When it is omitted, a default cap applies. [The blend](suggestion-blend.md) splits the limit into [slots](slot-budget.md): [queries](query-suggestion.md) get the larger share, [the catalog](catalog-suggestion-source.md) has its own ceiling, and each source passes its unused slots to the other.

## Example
```
GET /api/suggest?q=iph&limit=0    → 400 problem+json
GET /api/suggest?q=iph&limit=2.5  → 400 problem+json
GET /api/suggest?q=iph&limit=5    → 200; queries get ⌈0.6 × 5⌉ = 3 slots, the catalog gets the rest
GET /api/suggest?q=iph            → 200; at most 8 suggestions
```

## Known gaps
- The spec does not say how many slots [typo-corrected titles](typo-suggestion-source.md) get, or whether they only fill slots the other two sources leave empty.

## Used by
<!-- used-by:start -->
- [catalog-suggestion-source](catalog-suggestion-source.md)
- [query-suggestion](query-suggestion.md)
- [slot-budget](slot-budget.md)
- [suggestion-blend](suggestion-blend.md)
- [typo-suggestion-source](typo-suggestion-source.md)
<!-- used-by:end -->
