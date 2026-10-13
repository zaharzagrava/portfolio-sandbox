---
id: batching-not-supported
title: batching_not_supported
kind: term
status: draft
aliases: [batched array body]
defined_for: S48-bff
rules_hash: 30c006f4732a
---
# batching_not_supported
## Definition
`batching_not_supported` is the error code the [BFF ↗](../sw-external-terms.md#bff) returns when a [GraphQL request body ↗](../sw-external-terms.md#graphql) is a JSON array of several operations instead of a single operation. The BFF runs exactly one GraphQL operation per HTTP request. It rejects a batched body with a 400 before running any of the operations it contains. Each operation must go in its own request, so the [query limits](graphql-query-limits.md) and the [cost-based rate limit](rate-limit-cost.md) apply to each one separately. That last point is design intent (not stated in the spec).

## Example
A client sends this body to `POST /api/graphql`:
```json
[{"query": "{ a: products(ids: [\"…\"]) { priceMinor } }"},
 {"query": "{ b: products(ids: [\"…\"]) { currency } }"}]
```
The BFF answers `400 batching_not_supported`. The query text above is illustrative.

## Known gaps
- The spec does not say whether the error comes back as a [problem body ↗](../sw-external-terms.md#problem-json) or as a GraphQL `errors[]` entry.
- The spec does not say whether a one-element array is also rejected.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): B-08
- [graphql-body-size-limit](graphql-body-size-limit.md)
- [graphql-query-limits](graphql-query-limits.md)
- [rate-limit-cost](rate-limit-cost.md)
<!-- used-by:end -->
