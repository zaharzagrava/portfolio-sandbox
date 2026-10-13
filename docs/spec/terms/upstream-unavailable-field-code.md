---
id: upstream-unavailable-field-code
title: UPSTREAM_UNAVAILABLE (GraphQL field code)
kind: term
status: draft
aliases: []
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# UPSTREAM_UNAVAILABLE (GraphQL field code)
## Definition
`UPSTREAM_UNAVAILABLE` is the error code [the BFF ↗](../sw-external-terms.md#bff) puts on a GraphQL field when [the upstream behind that field](upstream.md) fails. The response still returns 200, and only the field that failed loses its data. That field gets an entry in the [GraphQL errors array](graphql-errors-array.md), which carries the field's [error path](graphql-error-path.md) and this code. Fields that do not depend on the failed upstream keep their data, so the client gets a [partial response](partial-response.md). It is a different code from the lowercase `upstream_unavailable`, which [fails the whole product page](upstream-unavailable.md).

## Example
A client runs `products(ids: [A, B])`, and the product batch call answers 503. The client still gets HTTP 200, shaped like this (illustrative):
```json
{
  "data": { "products": null },
  "errors": [{ "path": ["products"], "extensions": { "code": "UPSTREAM_UNAVAILABLE" } }]
}
```
Any field in the same query that does not use the product batch is returned unchanged.

## Known gaps
- The spec does not say where the code sits inside the error entry. Putting it in `extensions.code` follows the usual GraphQL convention, but the code does not confirm it.
- The spec does not say whether failures other than a 503 also produce this code, such as connection errors or an open circuit breaker. A field that runs past the operation deadline gets `BUDGET_EXCEEDED` instead.
- The spec does not say whether the BFF retries the GraphQL batch call before it sets this code. The retry rule only covers the product call on the product page.

## Used by
<!-- used-by:start -->
- [graphql-error-path](graphql-error-path.md)
- [graphql-errors-array](graphql-errors-array.md)
- [partial-response](partial-response.md)
- [upstream-unavailable](upstream-unavailable.md)
- [upstream](upstream.md)
<!-- used-by:end -->
