---
id: autocomplete-q-parameter
title: q (autocomplete query parameter)
kind: term
status: draft
aliases: [q]
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# q (autocomplete query parameter)
## Definition
`q` is the required query parameter of [`GET /suggest`](get-suggest.md) that holds what the buyer has typed so far. The endpoint [reduces it](normalised-text.md) the same way [S32](../capabilities/S32-product-search.md) reduces search text, and it echoes the reduced text as [`prefix`](suggest-prefix.md) in the response. A reduced `q` that is too long gives `400`. It is never truncated. A blank reduced `q` gives an empty, [cacheable ↗](../sw-external-terms.md#http-caching) answer without consulting any source. Wildcard, operator and markup characters are treated as plain text. A very short prefix gets no [catalog completions](catalog-completions.md).

## Example
```
GET /api/suggest?q=%20IPh%20%20one  → prefix: "iph one"
GET /api/suggest?q=iph*             → does not match "iphone 17"
GET /api/suggest                    → 400 (q missing)
```

## Known gaps
- The spec does not say whether the length limit counts characters as code points or as UTF-16 units.

## Used by
<!-- used-by:start -->
- [catalog-completions](catalog-completions.md)
- [normalised-text](normalised-text.md)
<!-- used-by:end -->
