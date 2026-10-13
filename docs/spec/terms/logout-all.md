---
id: logout-all
title: logout-all
kind: term
status: draft
aliases: [log out everywhere]
defined_for: S01-auth-sessions
rules_hash: 95bfc02ad34f
---
# logout-all
## Definition
`POST /auth/logout-all` revokes every session of the caller and answers `200 {revokedSessions}` with the number revoked. It is a [sensitive route](sensitive-route.md). It only touches the caller's sessions. The revocation is [durable](durable-conditional-write.md) and [idempotent ↗](../sw-external-terms.md#idempotency), and it ends the sessions' [refresh tokens](token-refresh.md). [Access tokens](access-token.md) already issued stay valid on ordinary routes until they expire. Sensitive routes reject them at once.

## Example
```
POST /auth/logout-all
Authorization: Bearer <access token>

200 {"revokedSessions": 3}      (count is illustrative)
```

## Known gaps
- The spec does not say what `revokedSessions` is on a repeated call: probably 0, but this is not stated.
- The spec does not say whether [cookie-mode](session-cookie.md) `logout-all` clears the three `__Host-` cookies. That is only stated for plain logout.
- Not confirmed in the code: that the route calls `SessionRevocationService.revokeAllForUser`.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-26
- [access-token](access-token.md)
- [durable-conditional-write](durable-conditional-write.md)
- [sensitive-route](sensitive-route.md)
- [session-cookie](session-cookie.md)
- [token-refresh](token-refresh.md)
<!-- used-by:end -->
