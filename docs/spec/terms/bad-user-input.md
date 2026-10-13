---
id: bad-user-input
title: BAD_USER_INPUT
kind: term
status: draft
aliases: [400 bad_user_input]
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# BAD_USER_INPUT
## Definition
`BAD_USER_INPUT` is the error code [the GraphQL endpoint](post-api-graphql.md) returns, with HTTP status 400, when a field argument has a value it does not accept. The case the spec names is `products(ids:)` called with more IDs than the [products(ids:) limit](products-ids-limit.md) allows. An empty ID list is not an error: it returns `[]`. `BAD_USER_INPUT` is about argument values. Depth, cost and [root-field](too-many-root-fields.md) problems in the query document get their own codes, such as [`QUERY_TOO_DEEP`](graphql-query-limits.md) and `TOO_MANY_ROOT_FIELDS`. The name follows a common GraphQL server convention for invalid arguments.

## Example
A query that asks for 51 products (the IDs are illustrative):
```graphql
{ products(ids: ["p1", "p2", "...", "p51"]) { priceMinor currency } }
```
The answer is `400 BAD_USER_INPUT`. The same query with `ids: []` returns `[]` and makes no upstream call.

## Known gaps
- The spec does not say where the code appears in the response, for example as the `code` of an entry in the [GraphQL errors array](graphql-errors-array.md), or what else the body contains.
- The spec does not say whether the check runs before any upstream call. Depth and cost limits are stated to run first, but this check is not.
- The spec does not say whether any other invalid argument besides an oversized `products(ids:)` list also gives `BAD_USER_INPUT`.

## Used by
<!-- used-by:start -->
- [graphql-errors-array](graphql-errors-array.md)
- [post-api-graphql](post-api-graphql.md)
- [products-ids-limit](products-ids-limit.md)
- [too-many-root-fields](too-many-root-fields.md)
<!-- used-by:end -->
