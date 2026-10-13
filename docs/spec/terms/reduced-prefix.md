---
id: reduced-prefix
title: Reduced prefix
kind: term
status: draft
aliases: [normalised prefix]
defined_for: S33-autocomplete
rules_hash: 11ffe7c487b2
---
# Reduced prefix
## Definition
The reduced prefix is the `q` parameter after it is cleaned the same way [S32](../capabilities/S32-product-search.md) cleans search text. The cleaning applies [compatibility folding ↗](../sw-external-terms.md#unicode-compatibility-folding), removes control characters, collapses whitespace, trims and lower-cases. The response returns it as `prefix`. Every later step uses it: the empty check, the length check, the [trie lookup ↗](../sw-external-terms.md#trie) and the key the answer is stored under in the catalog cache. The answer depends only on this prefix and a few other inputs, so `IPH` and `iph` get the same answer and share one [cache entry](cache-entry.md).

## Example
`GET /api/suggest?q=%20IPh%20%20one` returns `"prefix": "iph one"`.
`q=IPH` and `q=iph` within the catalog cache lifetime cause only one engine call (S33.B-12).
A blank `q` reduces to `""` and returns an empty, cacheable answer without consulting any source.

## Known gaps
- The spec does not say whether "normalised prefix" (catalog cache), "normalised text" (blend de-duplication) and "reduced `q`" are exactly the same function. It uses all three words.
- Not confirmed in the code: the build normalises logged queries with the same reduction. If it does not, some published queries might never match a prefix.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-15, R-17
- [autocomplete-cache-key](autocomplete-cache-key.md)
- [cache-entry](cache-entry.md)
- [catalog-title-source-adapter](catalog-title-source-adapter.md)
- [normalised-text](normalised-text.md)
- [suggestion-blocklist](suggestion-blocklist.md)
<!-- used-by:end -->
