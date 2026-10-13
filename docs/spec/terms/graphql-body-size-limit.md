---
id: graphql-body-size-limit
title: GraphQL body size limit
kind: term
status: draft
aliases: [8 kb, allowed body size, body size limit]
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# GraphQL body size limit
## Definition
The GraphQL body size limit is the largest request body [the BFF ↗](../sw-external-terms.md#bff) accepts on the GraphQL endpoint. If a body is larger, the BFF rejects the whole request with [`payload_too_large`](payload-too-large.md). The limit is a fixed BFF limit, like the [root-field cap](too-many-root-fields.md) and the ban on [batched bodies](batching-not-supported.md). Rejecting large bodies before any query runs keeps oversized documents away from the parser and the [upstreams](upstream.md). That reason is design intent (not stated in the spec).

## Example
A client sends a 9 KB query document (illustrative size) to [`POST /api/graphql`](post-api-graphql.md). The body is over the 8 KB limit, so the BFF answers `413 payload_too_large`.

## Known gaps
- The spec does not say whether "8 KB" means 8,000 or 8,192 bytes.
- The spec does not say how the limit applies to `GET /api/graphql`, where the operation is sent in the URL.
- The spec does not say whether the size is checked before parsing or whether any upstream call can happen first.

## Used by
<!-- used-by:start -->
- [batching-not-supported](batching-not-supported.md)
- [payload-too-large](payload-too-large.md)
- [post-csp-reports](post-csp-reports.md)
- [too-many-root-fields](too-many-root-fields.md)
- [upstream](upstream.md)
<!-- used-by:end -->
