---
id: transitional-block
title: TRANSITIONAL block
kind: term
status: draft
aliases: [transitional]
defined_for: S10-cart-checkout
rules_hash: 7a7586bb8f14
---
# TRANSITIONAL block
## Definition
A TRANSITIONAL block is a clearly marked section of a domain's exports. A model exported from inside it is a known, temporary exception to the [domain boundary rules](domain-boundary-rules.md). Outside the block, the domain exports no model, has no association or import into another domain, and calls no direct [`sequelize.transaction`](active-transaction.md). Design intent (not stated in the spec): the marker keeps legacy coupling visible and contained, so it can be removed later instead of spreading.

## Example
A [boundary review](boundary-review.md) of the domain reports:
- every exported model is inside the marked TRANSITIONAL block, so it raises no finding;
- one [table-ownership finding](table-ownership.md) remains: the S12 [export join](export-join.md) on `Product`.

## Known gaps
- The spec does not say which models are inside the block or which domain's block the finding refers to.
- The spec does not say when the block must be emptied, or what work removes it.
- The spec does not say how the block is marked in the code, for example with a comment or a separate file.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-46
- [boundary-finding](boundary-finding.md)
- [boundary-review](boundary-review.md)
- [domain-boundary-rules](domain-boundary-rules.md)
- [export-join](export-join.md)
- [table-ownership](table-ownership.md)
<!-- used-by:end -->
