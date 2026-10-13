---
id: session-cookie
title: Session cookie
kind: term
status: draft
aliases: [cookie-authenticated, session store]
defined_for: bff-aggregate
rules_hash: 0b66692d3742
---
# Session cookie
## Definition
The session cookie is `__Host-bff-session`, an [HttpOnly ↗](../sw-external-terms.md#httponly) cookie with an opaque value. It holds a browser's signed-in state, so the browser never holds a token. [The BFF ↗](../sw-external-terms.md#bff) keeps the matching session record, encrypted, in Redis. The Redis key is the [SHA-256 ↗](../sw-external-terms.md#sha-256) hash of the cookie value. If Redis is down, a request that carries the cookie gets `503 session_unavailable`.

## Example
```
Cookie: __Host-bff-session=Zk3q...  (illustrative opaque value)
```
The BFF hashes the value, finds the encrypted record in Redis, and calls [upstreams](upstream.md) with the token stored in it. The `Cookie` header itself is never forwarded.

## Known gaps
- The spec does not say how long a session lasts, or when it expires or is renewed.
- The spec does not say what the `__Host-bff-mfa` cookie holds or how it relates to the session cookie.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): B-06
- [S02](../capabilities/S02-mfa-oidc.md): B-05
- [S48](../capabilities/S48-bff.md): R-11, B-14, B-19
- [W01](../capabilities/W01-auth-account.md): R-04
- [bff-aggregate](../concepts/bff-aggregate.md): C-06
- [access-token](access-token.md)
- [ambiguous-credentials](ambiguous-credentials.md)
- [credential](credential.md)
- [csrf-token](csrf-token.md)
- [host-bff-mfa-cookie](host-bff-mfa-cookie.md)
- [mfa-management-endpoint](mfa-management-endpoint.md)
- [mfa-recovery-code-regenerate](mfa-recovery-code-regenerate.md)
- [origin-not-allowed](origin-not-allowed.md)
- [post-bff-session](post-bff-session.md)
- [registration-service](registration-service.md)
- [route-guard](route-guard.md)
- [session-store](session-store.md)
- [shop-status-gate](shop-status-gate.md)
- [token-refresh](token-refresh.md)
- [upstream](upstream.md)
<!-- used-by:end -->
