---
id: session-store
title: Session store
kind: term
status: draft
aliases: [session_unavailable]
defined_for: bff-aggregate
rules_hash: b90f6d554331
---
# Session store
## Definition
The session store is the Redis store that holds the [BFF ↗](../sw-external-terms.md#bff)'s browser sessions, so the browser only ever holds an [opaque session cookie](session-cookie.md) and never a token. Each record is encrypted and keyed by the [SHA-256 ↗](../sw-external-terms.md#sha-256) hash of the `__Host-bff-session` cookie value. If the store is down, any request that carries a cookie fails with `503 session_unavailable`, but requests without a session cookie are still served normally. Keying by a hash is design intent (not stated in the spec): if someone reads the store, they still cannot recover live cookie values.

## Example
The store is unavailable, and two requests arrive for the product page:
```
GET with Cookie: __Host-bff-session=…   → 503 session_unavailable
GET with no cookie                      → 200, page served normally
```

## Known gaps
- The spec does not say how long a session lives or when a record expires.
- The spec does not say what counts as "down". It could mean a connection error, a timeout, or both.
- Not confirmed in the code: whether the [`__Host-bff-mfa` cookie](host-bff-mfa-cookie.md)'s state is also kept in the session store.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): R-20, B-19
- [bff-composition-library](bff-composition-library.md)
- [host-bff-mfa-cookie](host-bff-mfa-cookie.md)
- [post-bff-session-logout](post-bff-session-logout.md)
- [post-bff-session](post-bff-session.md)
- [route-guard](route-guard.md)
- [session-controller](session-controller.md)
- [session-cookie](session-cookie.md)
- [session-expired](session-expired.md)
- [x-anonymous-id](x-anonymous-id.md)
<!-- used-by:end -->
