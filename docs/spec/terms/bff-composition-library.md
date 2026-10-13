---
id: bff-composition-library
title: BFF composition library
kind: term
status: draft
aliases: [composition library, libs/composition/bff]
defined_for: W01-auth-account
rules_hash: 84877a38102e
---
# BFF composition library
## Definition
The [BFF ↗](../sw-external-terms.md#bff) composition library is the backend code in `packages/backend/libs/composition/bff` that implements the BFF. It holds the [`SessionController`](session-controller.md) for sign-in and the session endpoints, with session records kept in the [session store](session-store.md). It also builds the [page aggregate](page-aggregate.md) for the product page from [sections](section.md). Each section calls its own [upstream](upstream.md), and the library reports per-section timings in the [`Server-Timing` ↗](../sw-external-terms.md#server-timing) header. It also checks request credentials such as [`X-Anonymous-Id`](x-anonymous-id.md) and enforces the [GraphQL query depth and cost limits](graphql-query-limits.md).

## Example
Folders verified in the code on 2026-10-13:
```
session/session.controller.ts   SessionController, behind POST /api/bff/session
page/section-registry.ts        product page sections (product [required](required-section.md), shop, trending, … optional)
credentials/credentials.ts      ANONYMOUS_ID pattern; a non-matching X-Anonymous-Id is dropped
graphql/limits.ts               QUERY_TOO_DEEP, QUERY_TOO_COSTLY, TOO_MANY_ROOT_FIELDS
```

## Known gaps
- The spec does not say which capability owns the library as a whole. The `/api/bff/session*` endpoints are only said to be owned by [S01](../capabilities/S01-auth-sessions.md), S02 or S48.
- Not confirmed in the code: whether the [`/api/bff/f/*` forwarder](bff-forwarder.md) and [`POST /api/graphql`](post-api-graphql.md) are served from this library, or whether it only holds the GraphQL limits.
- The spec does not say what "composition" means here. Reading it as "combining several upstream answers into one response" is design intent (not stated in the spec).

## Used by
<!-- used-by:start -->
- [bff-forwarder](bff-forwarder.md)
- [graphql-query-limits](graphql-query-limits.md)
- [page-aggregate](page-aggregate.md)
- [section](section.md)
- [session-controller](session-controller.md)
- [session-store](session-store.md)
- [upstream](upstream.md)
<!-- used-by:end -->
