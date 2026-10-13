---
id: products-ids-query
title: products(ids:) query
kind: term
status: draft
aliases: [products(ids:)]
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# products(ids:) query
## Definition
`products(ids:)` is a [GraphQL ↗](../sw-external-terms.md#graphql) field that returns products for a list of IDs. The result has the same length and order as the input. A repeated ID appears again, and an [invisible](search-visibility.md) product appears as `null`. [A loader](loader.md) removes duplicate IDs and sends the unique IDs to the [upstream](upstream.md) in one batch call. An empty list returns an empty list without any upstream call. Too many IDs give [`400 BAD_USER_INPUT`](bad-user-input.md).

## Example
B is invisible:
```graphql
{ products(ids: ["A", "B", "A", "C"]) { priceMinor currency } }
```
The result is `[A, null, A, C]`, and the batch call to the upstream carries A, B and C once each.

## Known gaps
- The spec does not state the largest allowed number of IDs. It only says that 51 IDs give `400 BAD_USER_INPUT`.
- The spec does not name the upstream endpoint that the batch call uses.

## Used by
<!-- used-by:start -->
- [graphql-error-path](graphql-error-path.md)
- [loader](loader.md)
- [products-ids-limit](products-ids-limit.md)
- [search-visibility](search-visibility.md)
- [upstream](upstream.md)
<!-- used-by:end -->
