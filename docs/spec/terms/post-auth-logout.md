---
id: post-auth-logout
title: POST /auth/logout
kind: term
status: draft
aliases: [/auth/logout]
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# POST /auth/logout
## Definition
`POST /auth/logout` ends the caller's current session, and only that one. It records a [session revocation](session-revocation.md), so the session's [refresh token](token-refresh.md) can no longer be exchanged. The revocation is [durable](durable-conditional-write.md) and [idempotent ↗](../sw-external-terms.md#idempotency): a repeat call succeeds again and keeps the first revocation time and reason. In [cookie delivery mode](cookie-delivery.md), it also clears the [`__Host-access`](host-access-cookie.md), [`__Host-refresh`](host-refresh-cookie.md) and [`__Host-csrf` ↗](../sw-external-terms.md#csrf-token) cookies. The [access token](access-token.md) already issued keeps working on ordinary routes until its [`exp` ↗](../sw-external-terms.md#jwt-exp). [Sensitive routes](sensitive-route.md) reject it at once.

## Example
A browser signed in with `delivery: "cookie"` sends `POST /auth/logout` with an [`X-CSRF-Token` ↗](../sw-external-terms.md#csrf-token) header equal to its `__Host-csrf` cookie, from an allowed [`Origin` ↗](../sw-external-terms.md#origin-header). The answer is `204`, and the three credential cookies are cleared. Sending the same request again also gives `204`. The stored revocation time and reason stay unchanged.

## Known gaps
- The spec does not say what the request must carry in [Bearer mode ↗](../sw-external-terms.md#authorization-bearer), such as whether the refresh token goes in the body or the access token alone is enough.
- The spec does not say which [revocation reason](session-limit.md) is recorded for a logout. It only says the first reason is kept.
- The spec does not say whether this route has its own [rate limit](rate-limit.md). It also doesn't say whether the `application/json`-only rule for [credential endpoints](credential.md) covers it.

## Used by
<!-- used-by:start -->
- [access-token](access-token.md)
- [cookie-delivery](cookie-delivery.md)
- [credential](credential.md)
- [durable-conditional-write](durable-conditional-write.md)
- [rate-limit](rate-limit.md)
- [sensitive-route](sensitive-route.md)
- [session-limit](session-limit.md)
- [session-revocation](session-revocation.md)
- [token-refresh](token-refresh.md)
<!-- used-by:end -->
