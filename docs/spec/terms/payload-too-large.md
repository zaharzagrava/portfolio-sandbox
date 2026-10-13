---
id: payload-too-large
title: payload_too_large
kind: term
status: draft
aliases: []
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# payload_too_large
## Definition
`payload_too_large` is the error code the [BFF ↗](../sw-external-terms.md#bff) returns with HTTP 413 when a GraphQL request body is larger than the [allowed body size](graphql-body-size-limit.md). The BFF rejects the body before parsing or running it, so no [upstream call](upstream.md) is made. Checking the size first keeps the parser away from huge documents, which is design intent (not stated in the spec).

## Example
A client sends a 9 KB query document (illustrative size) to [`POST /api/graphql`](post-api-graphql.md). The limit is 8 KB, so the BFF answers `413 payload_too_large`.

## Known gaps
- The spec does not say whether "8 KB" means 8,000 or 8,192 bytes.
- The spec does not say whether this limit also applies to [`/api/bff/*` endpoints](api-bff-endpoints.md) or only to `/api/graphql`.
- The spec does not say how the limit applies to GET requests, where the operation is sent in the URL.

## Used by
<!-- used-by:start -->
- [api-bff-endpoints](api-bff-endpoints.md)
- [graphql-body-size-limit](graphql-body-size-limit.md)
- [upstream](upstream.md)
<!-- used-by:end -->
