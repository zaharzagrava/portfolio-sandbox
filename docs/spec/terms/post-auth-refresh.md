---
id: post-auth-refresh
title: POST /auth/refresh
kind: term
status: draft
aliases: [/auth/refresh]
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# POST /auth/refresh
## Definition
`POST /auth/refresh` is the S01 endpoint that swaps a [refresh token](token-refresh.md) for a new [access token](access-token.md) and a new refresh token. The new tokens belong to the same session, and the old refresh token becomes a [spent token](refresh-token-rotation.md) (refresh token rotation). If someone presents a spent token again, the whole session is revoked. When two exchanges of one token arrive at the same time, only one of them succeeds ([optimistic concurrency](optimistic-concurrency.md)). A role change reaches the caller only at their next refresh.

Every failure (unknown, expired or revoked token, or a deleted user) gets the same [`invalid_refresh_token`](invalid-refresh-token-error.md) answer. An oversized value is rejected as a bad request instead. In [cookie delivery](cookie-delivery.md), the caller sends no token in the body. The endpoint reads the [`__Host-refresh` cookie](host-refresh-cookie.md), needs a valid [CSRF token ↗](../sw-external-terms.md#csrf-token), rotates all three cookies and returns no token. A request refused by the [rate limit](rate-limit.md) or by the CSRF check does not consume the refresh token. Responses carry [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store).

## Example
A browser in cookie mode refreshes its session:
```
POST /auth/refresh
Cookie: __Host-refresh=<refresh token>; __Host-csrf=<csrf token>
X-CSRF-Token: <csrf token>
Content-Type: application/json
```
The answer sets new `__Host-access`, `__Host-refresh` and `__Host-csrf` cookies, and the old refresh token is now spent. Sending that same request again with the old cookie revokes the session.

## Known gaps
- The spec does not say the name of the body field that carries the refresh token in non-cookie mode, or the exact shape of the response body.
- The spec does not say which status and error code the caller gets when they present a spent refresh token. It only says the session is revoked. S01.R-21 does not list spent tokens.
- The spec does not say whether a successful refresh changes the session's [`lastUsedAt`](session-last-used-at.md) or pushes back its end date. S01.R-22 fixes the session end relative to when the session was created.

## Used by
<!-- used-by:start -->
- [access-token](access-token.md)
- [cookie-delivery](cookie-delivery.md)
- [host-refresh-cookie](host-refresh-cookie.md)
- [optimistic-concurrency](optimistic-concurrency.md)
- [rate-limit](rate-limit.md)
- [refresh-token-rotation](refresh-token-rotation.md)
- [token-refresh](token-refresh.md)
<!-- used-by:end -->
