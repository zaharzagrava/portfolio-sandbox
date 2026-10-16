---
id: boundary-finding
title: Boundary finding
kind: term
status: draft
aliases: [finding, findings]
defined_for: S10-cart-checkout
rules_hash: 90500c2c457b
---
# Boundary finding
## Definition
A boundary finding is one item that a boundary review reports. Each finding is a place where a [domain](domain.md)'s code breaks the [domain boundary rules](domain-boundary-rules.md). A model exported from inside the domain's [TRANSITIONAL block](transitional-block.md) is a known exception, so it raises no finding. When a code path reaches a table the domain does not own, the review reports a [table-ownership finding](table-ownership.md).

## Example
A boundary review of one domain reports:
- every exported model is inside the TRANSITIONAL block, so none of them raises a finding;
- one table-ownership finding remains: the S12 export join on `Product`.

## Known gaps
- The spec does not say whether an open finding blocks a merge or a release.
- The spec does not say whether the review that produces findings is automated or manual, or when it runs.
- The spec does not say whether there are other kinds of finding besides table-ownership findings, or how a finding is recorded and closed.

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): R-17, B-15
- [boundary-review](boundary-review.md)
- [check-boundaries](check-boundaries.md)
- [domain-boundary-rules](domain-boundary-rules.md)
- [domain](domain.md)
- [table-ownership](table-ownership.md)
- [transitional-block](transitional-block.md)
<!-- used-by:end -->
