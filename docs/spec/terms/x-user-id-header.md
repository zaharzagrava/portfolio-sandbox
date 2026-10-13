---
id: x-user-id-header
title: X-User-Id header
kind: term
status: draft
aliases: [x-user-id]
defined_for: access-token-session
rules_hash: e3b0c44298fc
---
# X-User-Id header
## Definition
`X-User-Id` is an example of an [identity header](identity-headers.md) that a caller or proxy might add to say which user is calling. This system must never trust it. [The principal comes only from the verified token.](principal.md) Design intent (not stated in the spec): any client can set a header, so trusting one would let callers impersonate other users.

## Example
```
Authorization: Bearer <token for user 17>
X-User-Id: 99
```
The values are illustrative. The request runs as user 17. The `X-User-Id` value has no effect.

## Known gaps
- The spec does not say whether a request carrying `X-User-Id` is rejected, or whether the header is just ignored or [stripped at the edge](edge-stripping.md).
- The spec does not list the other "identity headers" that fall under the same rule.

## Used by
<!-- used-by:start -->
- [edge-stripping](edge-stripping.md)
- [identity-headers](identity-headers.md)
- [principal](principal.md)
<!-- used-by:end -->
