---
id: products-ids-limit
title: products(ids:) limit
kind: term
status: draft
aliases: [50 ids]
defined_for: S48-bff
rules_hash: 333e417c28c8
---
# products(ids:) limit
## Definition
This limit sets how many IDs a client can pass in one [`products(ids:)` GraphQL field](products-ids-query.md). If the list is too long, the [BFF ↗](../sw-external-terms.md#bff) answers [`400 BAD_USER_INPUT`](bad-user-input.md) and makes no [upstream call](upstream.md). An empty list returns an empty list, also with no upstream call. This field limit is separate from the [loader's cap on IDs per batch call](loader.md) to the upstream.

## Example
- `products(ids: [<51 IDs>])` → `400 BAD_USER_INPUT`
- `products(ids: [])` → `[]`, with no upstream call

## Known gaps
- The spec does not state the maximum number of IDs. It only says that 51 is rejected, which suggests a maximum of 50, but no rule confirms this.
- The spec does not say whether duplicate IDs (as in `[A, B, A, C]`) count toward the limit before or after they are removed.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): B-09
- [bad-user-input](bad-user-input.md)
- [loader](loader.md)
- [products-ids-query](products-ids-query.md)
- [upstream](upstream.md)
<!-- used-by:end -->
