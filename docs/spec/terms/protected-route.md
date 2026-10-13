---
id: protected-route
title: Protected route
kind: term
status: draft
aliases: [protected routes]
defined_for: S01-auth-sessions
rules_hash: bf6b05fd9c04
---
# Protected route
## Definition
A protected route is an endpoint that only answers callers who send a [valid credential](access-token.md). A request with no credential gets `401`. [Authentication and throttling run before body validation](rate-limit.md), so a request with no credential is rejected before its body is checked. [The principal](principal.md) comes from the token alone. The only accepted carriers are [`Authorization: Bearer` ↗](../sw-external-terms.md#authorization-bearer) and the [`__Host-access` cookie](host-access-cookie.md). A [sensitive route](sensitive-route.md) is a stricter kind of protected route that also rejects tokens from [revoked sessions](session-revocation.md) straight away.

## Example
A call to `GET /auth/me` with no `Authorization` header and no `__Host-access` cookie gets `401`. Adding `X-User-Id: 42` does not help, because identity headers are never trusted (the value is illustrative).
```
GET /auth/me
X-User-Id: 42        ← ignored
→ 401
```

## Known gaps
- The spec does not list which routes are protected. Treating `GET /auth/me` and `GET /auth/sessions` as protected is an inference from their purpose ("the signed-in user", "the caller's sessions").
- The spec does not give the error code or body for a request with no credential. It only states the `401` status (S01.R-19).

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): B-17
- [W01](../capabilities/W01-auth-account.md): R-20
- [access-token](access-token.md)
- [host-access-cookie](host-access-cookie.md)
- [principal](principal.md)
- [rate-limit](rate-limit.md)
- [route-guard](route-guard.md)
- [sensitive-route](sensitive-route.md)
- [session-revocation](session-revocation.md)
- [stock-verifier](stock-verifier.md)
<!-- used-by:end -->
