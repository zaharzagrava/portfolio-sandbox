---
id: graphql-error-path
title: Error path
kind: term
status: draft
aliases: [path]
defined_for: S48-bff
rules_hash: 8f4772adba6f
---
# Error path
## Definition
`path` is the member of an entry in [`errors[]`](graphql-errors-array.md) that points to the field that failed. With it, a client can tell which part of `data` is missing and why. Other fields in the response are unaffected.

## Example
When [the product batch](products-ids-query.md) answers 503, the error entry carries a `path` such as `["products"]` (illustrative) together with the code [`UPSTREAM_UNAVAILABLE`](upstream-unavailable-field-code.md).

## Known gaps
- The spec does not say whether `path` includes list indexes, such as `["products", 1]`, when only some items in a list fail.

## Used by
<!-- used-by:start -->
- [products-ids-query](products-ids-query.md)
- [upstream-unavailable-field-code](upstream-unavailable-field-code.md)
<!-- used-by:end -->
