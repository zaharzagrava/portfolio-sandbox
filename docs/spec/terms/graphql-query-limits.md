---
id: graphql-query-limits
title: GraphQL query depth and cost limits
kind: term
status: draft
aliases: [query cost, query depth]
defined_for: bff-aggregate
rules_hash: 6ce1bb197db6
---
# GraphQL query depth and cost limits
## Definition
The GraphQL query depth and cost limits are checks the [BFF ↗](../sw-external-terms.md#bff) runs on every GraphQL query before it calls any [upstream](upstream.md). Depth counts how many field levels a query nests. Cost charges one unit per field, multiplied by the sizes of all lists above that field. List sizes come from literals, variables and defaults. A query over either limit is rejected and no [domain API](domain-api-origin.md) is called. A separate limit caps how many IDs one [loader batch call](loader.md) may carry.

## Example
A `recommendations` list counts as 8 items unless `first` sets another size. In this query, each field under `recommendations` therefore costs 8 units:
```graphql
{ product(id: "p1") { recommendations { name } } }   # field names other than recommendations are illustrative
```
An illustrative tally: `product` 1 + `recommendations` 1 + `name` 1×8 = 10. A query that goes too deep is rejected with `QUERY_TOO_DEEP`, and one that costs too much with `QUERY_TOO_COSTLY`.

## Known gaps
- The spec does not say how many root fields trigger `[TOO_MANY_ROOT_FIELDS](too-many-root-fields.md)`. The code has this code, but the rules give no value for it.
- The spec does not say what HTTP status or response shape a rejected query gets.
- The spec does not say what happens when a loader needs more IDs than one batch call may carry. It might split them into several calls or fail.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): R-16
- [bff-aggregate](../concepts/bff-aggregate.md): C-07
- [batching-not-supported](batching-not-supported.md)
- [bff-composition-library](bff-composition-library.md)
- [domain-api-origin](domain-api-origin.md)
- [loader](loader.md)
- [post-api-graphql](post-api-graphql.md)
- [too-many-root-fields](too-many-root-fields.md)
- [upstream](upstream.md)
<!-- used-by:end -->
