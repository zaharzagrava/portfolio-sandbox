---
id: partial-response
title: Partial response
kind: term
status: draft
aliases: [independent fields]
defined_for: S48-bff
rules_hash: 980d27c69508
---
# Partial response
## Definition
A partial response is a [GraphQL ↗](../sw-external-terms.md#graphql) answer where some fields failed and the fields that do not depend on them are still returned. The status is 200. Failed fields are reported in [`errors[]`](graphql-errors-array.md) with their [`path`](graphql-error-path.md) and an error code. A field that passes the [operation deadline](operation-deadline.md) is reported as [`BUDGET_EXCEEDED`](budget-exceeded.md) instead of delaying the whole response. One slow or failing [upstream](upstream.md) does not take down unrelated data. That is design intent (not stated in the spec), and it matches the per-section degrading of the product page.

## Example
A query asks for [`products(ids: [...])`](products-ids-query.md) and another [root field](too-many-root-fields.md). The product batch answers 503. The response is 200, the products part is reported in `errors[]` with [`UPSTREAM_UNAVAILABLE`](upstream-unavailable-field-code.md), and the other root field keeps its data.

## Known gaps
- The spec does not define when a field counts as "independent".
- The spec does not say whether a failed field that is not allowed to be null makes its parent field `null` as well.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): B-07
- [operation-deadline](operation-deadline.md)
- [too-many-root-fields](too-many-root-fields.md)
- [upstream-unavailable-field-code](upstream-unavailable-field-code.md)
- [upstream](upstream.md)
<!-- used-by:end -->
