---
id: graphql-introspection
title: GraphQL introspection
kind: term
status: draft
aliases: [__schema, introspection]
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# GraphQL introspection
## Definition
[GraphQL introspection ↗](../sw-external-terms.md#graphql-introspection) is a query that asks the server to describe its own schema, using fields such as `__schema`. With [production configuration](production-configuration.md), [the BFF ↗](../sw-external-terms.md#bff) refuses these queries with the code [`INTROSPECTION_DISABLED`](introspection-disabled.md) and makes no [upstream call](upstream.md). Hiding the schema from outside callers in production is design intent (not stated in the spec).

## Example
```graphql
{ __schema { types { name } } }
```
With production configuration, the response carries `INTROSPECTION_DISABLED`, and the BFF makes 0 upstream calls.

## Known gaps
- The spec does not say which HTTP status comes with `INTROSPECTION_DISABLED`, or whether the code arrives in `errors[]`.
- The spec does not say whether `__type` queries are also blocked, or whether introspection works outside production.
- The spec does not say whether the check happens before or after the [trusted-document allowlist](trusted-document-allowlist.md) check.

## Used by
<!-- used-by:start -->
- [production-configuration](production-configuration.md)
- [trusted-document-allowlist](trusted-document-allowlist.md)
- [upstream](upstream.md)
<!-- used-by:end -->
