---
id: web-rewrite
title: Web rewrite
kind: term
status: draft
aliases: []
defined_for: S48-bff
rules_hash: 8c4b994809e8
---
# Web rewrite
## Definition
A web rewrite is a routing rule on the [web front end](front-end-origin.md). It sends requests for [`/api/graphql`](post-api-graphql.md) and [`/api/bff/*`](api-bff-endpoints.md) to the [BFF ↗](../sw-external-terms.md#bff). The browser keeps calling its own [front-end origin](front-end-origin.md) and never addresses the BFF directly. This keeps the [`__Host-` cookies](host-access-cookie.md) ([`__Host-bff-session`](session-cookie.md), [`__Host-bff-csrf` ↗](../sw-external-terms.md#csrf-token), [`__Host-bff-mfa`](host-bff-mfa-cookie.md)) on one origin, so the browser sends them with every BFF call. The same mechanism also routes the [`/api/bff/f/*` forwarder](bff-forwarder.md).

## Example
On the web front end, a page script sends `POST /api/graphql` to its own origin. The web rewrite passes the request to the BFF. The browser attaches `__Host-bff-session` and `__Host-bff-csrf` because the request never leaves that origin.

## Known gaps
- The spec does not say where the rewrites are configured or which web application owns them.
- The spec does not say whether the native clients use the rewrites or call the BFF in another way.
- Not confirmed in the code: the verified notes cover only `packages/backend/libs/composition/bff`, not the rewrite configuration.

## Used by
<!-- used-by:start -->
- [api-bff-endpoints](api-bff-endpoints.md)
- [bff-forwarder](bff-forwarder.md)
- [front-end-origin](front-end-origin.md)
- [host-access-cookie](host-access-cookie.md)
<!-- used-by:end -->
