---
id: export-join
title: Export join
kind: term
status: draft
aliases: [s12 export join]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# Export join
## Definition
The export join is a database join in the S12 export code that reads the `Product` table. A [boundary review](boundary-review.md) reports it as a [table-ownership finding](table-ownership.md). This means the join reaches a table that the exporting code's domain does not own, which breaks the [domain boundary rules](domain-boundary-rules.md). It is still open; the [TRANSITIONAL block](transitional-block.md) does not cover it.

## Example
The boundary review lists it as its only remaining finding:
```
table-ownership: S12 export join on `Product`
```

## [Known gaps](known-gaps.md)
- The spec does not say what S12 exports, or whether this is the export behind [`GET /shops/:shopId/export`](get-shop-export.md).
- The spec does not say which domain owns `Product` or which domain contains the join.
- The spec does not say how or when the join will be replaced, for example with a call to the owning domain's export.

## Used by
<!-- used-by:start -->
- [boundary-review](boundary-review.md)
- [domain-boundary-rules](domain-boundary-rules.md)
- [known-gaps](known-gaps.md)
- [table-ownership](table-ownership.md)
- [transitional-block](transitional-block.md)
<!-- used-by:end -->
