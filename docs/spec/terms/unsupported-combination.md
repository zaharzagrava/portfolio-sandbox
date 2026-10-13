---
id: unsupported-combination
title: unsupported_combination (422)
kind: term
status: draft
aliases: [unsupported_combination]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# unsupported_combination (422)
## Definition
`unsupported_combination` is the error code returned with a `422` when [semantic search](semantic-search.md) is combined with [`facets`](search-facets.md) or [`cursor`](pagination-cursor.md). [The problem body](problem-body.md) carries a `parameters` member that names the parameters that cannot be combined. [Semantic mode](search-mode.md) returns only the nearest products up to `limit`, so it offers no facets and no paging. Design intent (not stated in the spec): nearest-neighbour results form neither a full match set to count facets over nor a stable order to page through.

## Example
```
GET /products/search?q=cosy+winter+jacket&semantic=true&facets=true
→ 422  { "code": "unsupported_combination", "parameters": ["facets"], ... }
```
(The exact `parameters` value is illustrative.)

## Known gaps
- The spec does not give the exact shape of `parameters`. For example, it does not say whether the list includes `semantic`, or whether it is an array of names.
- The spec does not say whether an explicit `facets=false` together with `semantic=true` is also refused.

## Used by
<!-- used-by:start -->
- [problem-body](problem-body.md)
- [search-mode](search-mode.md)
- [semantic-search](semantic-search.md)
<!-- used-by:end -->
