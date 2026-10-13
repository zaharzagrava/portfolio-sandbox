---
id: suggest-prefix
title: prefix (suggest response member)
kind: term
status: draft
aliases: [prefix]
defined_for: S33-autocomplete
rules_hash: b3a36ad28664
---
# prefix (suggest response member)
## Definition
`prefix` is the member of the [`GET /suggest`](query-suggestions.md) response that shows the text the server actually looked up. The server reduces the raw [`q`](autocomplete-q-parameter.md) the same way [S32](../capabilities/S32-product-search.md) reduces search text: [folding](search-query-sanitisation.md), control-character removal, whitespace collapse, trimming and lower-casing. The response echoes the reduced text so the caller can check which input the suggestions belong to. When the reduced text is empty, `prefix` is the empty string and [no source is consulted](suggestion-source.md).

## Example
`GET /api/suggest?q=IPH` answers with `prefix: "iph"`.
```json
{ "prefix": "iph", "suggestions": [ ... ], "degraded": [] }
```

## Known gaps
- The spec does not say whether the front end should compare `prefix` with what it sent, for example to drop answers that arrive out of order. That use is design intent (not stated in the spec).

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): R-04
- [query-suggestion](query-suggestion.md)
- [search-query-sanitisation](search-query-sanitisation.md)
- [stale-response-discard](stale-response-discard.md)
- [suggestion-source](suggestion-source.md)
<!-- used-by:end -->
