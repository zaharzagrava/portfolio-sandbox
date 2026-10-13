---
id: cookie-delivery
title: Cookie delivery
kind: term
status: draft
aliases: []
defined_for: S02-mfa-oidc
rules_hash: 369df0d5b23e
---
# Cookie delivery
## Definition
Cookie delivery is the mode in which a successful login hands the [session](session-lifetime.md) to the browser as cookies instead of returning tokens in the response body. When [verify](mfa-verify-endpoint.md) succeeds in this mode, three cookies are set and no token appears in the body. The request must carry an allowed [`Origin` ↗](../sw-external-terms.md#origin-header); any other origin gets `[403 origin_not_allowed](origin-not-allowed.md)`. Design intent (not stated in the spec): the origin check protects cookie-based sessions against [cross-site requests ↗](../sw-external-terms.md#csrf-token).

## Example
```http
POST /auth/mfa/verify
Origin: https://evil.example
→ 403 origin_not_allowed
```
The same request from the allowed [front-end origin](front-end-origin.md) returns success, with three `Set-Cookie` headers and no token in the body.

## Known gaps
- The spec does not name the three cookies that are set.
- The spec does not say how a client chooses cookie delivery over tokens in the body.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): B-06
- [S02](../capabilities/S02-mfa-oidc.md): B-05
- [front-end-origin](front-end-origin.md)
- [host-refresh-cookie](host-refresh-cookie.md)
- [mfa-verify-endpoint](mfa-verify-endpoint.md)
- [origin-allow-list](origin-allow-list.md)
- [origin-not-allowed](origin-not-allowed.md)
- [post-auth-login](post-auth-login.md)
- [post-auth-logout](post-auth-logout.md)
- [post-auth-refresh](post-auth-refresh.md)
- [session-lifetime](session-lifetime.md)
<!-- used-by:end -->
