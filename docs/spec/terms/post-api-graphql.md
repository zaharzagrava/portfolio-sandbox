---
id: post-api-graphql
title: POST /api/graphql
kind: term
status: draft
aliases: [/api/graphql]
defined_for: S48-bff
rules_hash: fae5644c17eb
---
# POST /api/graphql
## Definition
`POST /api/graphql` is the [BFF ↗](../sw-external-terms.md#bff)'s read-only GraphQL entry point. It shares the `/api/graphql` route with GET. Each request gets its own [loaders](loader.md), and the BFF checks [query depth, cost and size](graphql-query-limits.md) before calling any [upstream](upstream.md). Outside local development, only [allowlisted documents](trusted-document-allowlist.md) run, and production rejects [introspection ↗](../sw-external-terms.md#graphql-introspection). A cost-based rate limit applies per [principal](principal.md). Mutations, subscriptions and batched array bodies are rejected. Cookie-authenticated POSTs must carry the CSRF token.

## Example
```graphql
{ products(ids: ["A", "B", "A", "C"]) { ... } }
```
B is invisible, so the result is `[A, null, A, C]`. The batch call upstream carries A, B and C once each.

## Known gaps
- The spec does not say how mutations will be forwarded. They are rejected today, and the future contract is untested.
- The spec does not state the trusted-document rules or the GraphQL credentials and CSRF rules as rules. AS-37 and AS-42 test them, but neither is tied to a rule.
- The spec does not say what differs between POST and GET, apart from caching for a known hash sent with GET and no credentials.

## Used by
<!-- used-by:start -->
- [bad-user-input](bad-user-input.md)
- [graphql-query-limits](graphql-query-limits.md)
- [loader](loader.md)
- [principal](principal.md)
- [trusted-document-allowlist](trusted-document-allowlist.md)
- [upstream](upstream.md)
<!-- used-by:end -->
