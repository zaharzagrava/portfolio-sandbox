---
id: host-access-cookie
title: __Host-access cookie
kind: term
status: draft
aliases: [__host-access]
defined_for: access-token-session
rules_hash: e013f15948f2
---
# __Host-access cookie
## Definition
`__Host-access` is a cookie that may carry an [access token](access-token.md). Besides [`Authorization: Bearer` ↗](../sw-external-terms.md#authorization-bearer), it is the only allowed way to send credentials. Services ignore credentials sent any other way.

## Example
```
Cookie: __Host-access=<access token>
```
The token value is a placeholder.

## Known gaps
- The spec does not say who sets or sends this cookie. Browsers must never hold a token, and [the BFF code ↗](../sw-external-terms.md#bff) uses [`__Host-bff-session`](session-cookie.md) instead.
- The spec does not say which credential wins when a request carries both this cookie and an `Authorization: Bearer` header.
- Not confirmed in the code: the verified BFF notes list `__Host-bff-session`, [`__Host-bff-csrf` ↗](../sw-external-terms.md#csrf-token) and `__Host-bff-mfa`, but not `__Host-access`.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-16
- [access-token](access-token.md)
- [api-bff-endpoints](api-bff-endpoints.md)
- [protected-route](protected-route.md)
- [service-to-service-token](service-to-service-token.md)
- [web-rewrite](web-rewrite.md)
<!-- used-by:end -->
