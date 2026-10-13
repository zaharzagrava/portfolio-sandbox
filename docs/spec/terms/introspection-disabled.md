---
id: introspection-disabled
title: INTROSPECTION_DISABLED
kind: term
status: draft
aliases: []
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# INTROSPECTION_DISABLED
## Definition
`INTROSPECTION_DISABLED` is the error code [the BFF ↗](../sw-external-terms.md#bff) returns when a client sends a [GraphQL introspection query ↗](../sw-external-terms.md#graphql-introspection) under [production configuration](production-configuration.md). The BFF rejects the query without making any [upstream call](upstream.md). Hiding the schema from outside callers in production is design intent (not stated in the spec).

## Example
A client sends this query to `POST /api/graphql` while the BFF runs with production configuration:
```graphql
{ __schema { types { name } } }
```
The response carries `INTROSPECTION_DISABLED`, and the BFF makes 0 upstream calls (S48.B-13).

## Known gaps
- The spec does not say which HTTP status comes with `INTROSPECTION_DISABLED`, or whether the code arrives as an entry in [`errors[]`](graphql-errors-array.md).
- The spec does not say whether queries that use `__type` (and not `__schema`) are also blocked.
- The spec does not say whether this check runs before or after the [trusted-document allowlist](trusted-document-allowlist.md) check.

## Used by
<!-- used-by:start -->
- [production-configuration](production-configuration.md)
- [trusted-document-allowlist](trusted-document-allowlist.md)
- [upstream](upstream.md)
<!-- used-by:end -->
