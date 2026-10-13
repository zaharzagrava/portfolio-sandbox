---
id: operation-deadline
title: GraphQL operation deadline
kind: term
status: draft
aliases: [operation deadline]
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# GraphQL operation deadline
## Definition
The GraphQL operation deadline is the time limit for one whole GraphQL request on `/api/graphql`. When it passes, the [BFF ↗](../sw-external-terms.md#bff) stops waiting for slow [upstreams](upstream.md) and answers with what it has. Each field still waiting for an upstream gets an entry in the [GraphQL errors array](graphql-errors-array.md) with the code [`BUDGET_EXCEEDED`](budget-exceeded.md). It does the same job for GraphQL that the [page deadline](page-deadline.md) does for the product page endpoint. Design intent (not stated in the spec): one slow upstream should not be able to hold a client request open without limit.

## Example
The operation deadline is 2,000 ms. The upstream behind `products(ids:)` answers only after 5 s. The client gets its response within 2,100 ms, and an entry for that field in `errors[]`:
```json
{ "path": ["products"], "extensions": { "code": "BUDGET_EXCEEDED" } }
```
(the exact entry shape and the `products` path are illustrative)

## Known gaps
- The spec does not say whether fields that finished before the deadline are kept. It says so only for an upstream 503 (S48.B-07).
- The spec does not say when the deadline starts counting: on request arrival, or after the query is parsed and checked against the depth and cost limits.
- The spec does not say which HTTP status the response has when the deadline passes, or whether the deadline can be set per operation.

## Used by
<!-- used-by:start -->
- [budget-exceeded](budget-exceeded.md)
- [graphql-errors-array](graphql-errors-array.md)
- [page-deadline](page-deadline.md)
- [partial-response](partial-response.md)
- [upstream](upstream.md)
<!-- used-by:end -->
