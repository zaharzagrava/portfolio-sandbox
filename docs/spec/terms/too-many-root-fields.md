---
id: too-many-root-fields
title: TOO_MANY_ROOT_FIELDS
kind: term
status: draft
aliases: [root fields]
defined_for: bff-aggregate
rules_hash: 857b76401d5f
---
# TOO_MANY_ROOT_FIELDS
## Definition
`TOO_MANY_ROOT_FIELDS` is an error code [the BFF's GraphQL limits](graphql-query-limits.md) use when a query has too many fields at its top level. It sits in the same limits code as [`QUERY_TOO_DEEP`](graphql-query-limits.md) and [`QUERY_TOO_COSTLY`](graphql-query-limits.md). Root fields are the entry points of a query. Each one can start its own set of [upstream calls](upstream.md). The cap likely exists so one request cannot fan out into many separate page loads (design intent, not stated in the spec).

## Example
This query asks for the same root field many times under different aliases. With enough of them, the [BFF ↗](../sw-external-terms.md#bff) rejects it with `TOO_MANY_ROOT_FIELDS`:
```graphql
{ p1: product(id: "p1") { name }  p2: product(id: "p2") { name }  p3: product(id: "p3") { name } }   # aliases, IDs and field names are illustrative
```

## Known gaps
- The spec does not say how many root fields are allowed. The code has the code, but the rules give no value for it.
- The spec does not say whether this check runs before any upstream call. Rule C-07 promises that only for depth and cost.
- The spec does not say whether aliased copies of one field count separately, or what HTTP status and response shape a rejected query gets.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): B-08
- [bad-user-input](bad-user-input.md)
- [graphql-body-size-limit](graphql-body-size-limit.md)
- [graphql-query-limits](graphql-query-limits.md)
- [partial-response](partial-response.md)
- [upstream](upstream.md)
<!-- used-by:end -->
