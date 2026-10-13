---
id: edge-stripping
title: Edge stripping of headers
kind: term
status: draft
aliases: [edge, stripped]
defined_for: access-token-session
rules_hash: e3b0c44298fc
---
# Edge stripping of headers
## Definition
Edge stripping means removing certain headers from an incoming request at the edge, before any service reads them. The edge is the first component that receives outside traffic. Here it applies to [identity headers](identity-headers.md) such as `X-User-Id`, because the system must never trust them. [The principal](principal.md) must come only from the [verified access token](access-token.md). Stripping is one possible extra defence on top of that rule. Design intent (not stated in the spec): a client can set any header, so removing these early means no service code can rely on one by mistake.

## Example
```
Arrives at the edge:
  Authorization: Bearer <token for user 17>
  X-User-Id: 99

Reaches the service:
  Authorization: Bearer <token for user 17>
```
The values are illustrative. The request runs as user 17 whether or not `X-User-Id` was stripped, because the principal comes from the token.

## Known gaps
- The spec does not say whether this system strips identity headers at the edge, or only ignores them.
- The spec does not say which component counts as "the edge" (a gateway, a proxy or the [BFF ↗](../sw-external-terms.md#bff)) or which headers it removes.
- The spec does not say whether a request that carries an identity header is rejected rather than stripped or ignored.

## Used by
<!-- used-by:start -->
- [access-token](access-token.md)
- [identity-headers](identity-headers.md)
- [principal](principal.md)
- [x-user-id-header](x-user-id-header.md)
<!-- used-by:end -->
