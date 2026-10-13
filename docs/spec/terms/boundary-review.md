---
id: boundary-review
title: Boundary review
kind: term
status: draft
aliases: [domain boundary review]
defined_for: S10-cart-checkout
rules_hash: 14f91bf52390
---
# Boundary review
## Definition
A boundary review checks one [domain](domain.md)'s code against the [domain boundary rules](domain-boundary-rules.md) and reports what breaks them as [findings](boundary-finding.md). A model exported from inside the domain's [TRANSITIONAL block](transitional-block.md) raises no finding, because it is a known exception. A code path that reaches a table the domain does not own is reported as a [table-ownership finding](table-ownership.md).

## Example
A boundary review of a domain reports:
- every exported model is inside the marked TRANSITIONAL block, so no finding is raised;
- one table-ownership finding remains: the [S12 export join](export-join.md) on `Product`.

## Known gaps
- The spec does not say whether the review is automated or manual, or when it runs.
- The spec does not say whether an open finding blocks a merge or a release.

## Used by
<!-- used-by:start -->
- [boundary-finding](boundary-finding.md)
- [domain-boundary-rules](domain-boundary-rules.md)
- [domain](domain.md)
- [export-join](export-join.md)
- [table-ownership](table-ownership.md)
- [transitional-block](transitional-block.md)
<!-- used-by:end -->
