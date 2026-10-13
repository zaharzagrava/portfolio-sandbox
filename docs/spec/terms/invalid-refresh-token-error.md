---
id: invalid-refresh-token-error
title: invalid_refresh_token error
kind: term
status: draft
aliases: [invalid_refresh_token]
defined_for: access-token-session
rules_hash: e3b0c44298fc
---
# invalid_refresh_token error
## Definition
`invalid_[refresh](token-refresh.md)_token` is the single error [S01](../capabilities/S01-auth-sessions.md) returns when a refresh fails. The token may be unknown or expired, [its session may be revoked](session-revocation.md), or its user may be deleted: the error is the same in every case. [An oversized value is rejected earlier as a bad request](oversized-refresh-token.md) instead. The point of one identical error is that callers cannot tell which case occurred, for example whether a token or user ever existed. That reason is design intent (not stated in the spec).

## Example
A refresh with the token of a deleted user and a refresh with a made-up token both get the same answer:
```
HTTP/1.1 401 Unauthorized
{"error": "invalid_refresh_token"}
```
(The body shape is illustrative. The spec names only the status and the code.)

## Known gaps
- The spec does not say what the response body looks like.
- The spec does not say whether presenting a [spent refresh token](refresh-token-rotation.md) also returns `invalid_refresh_token`. Spent tokens are not in the listed cases, although reusing one revokes the session.

## Used by
<!-- used-by:start -->
- [oversized-refresh-token](oversized-refresh-token.md)
- [refresh-token-rotation](refresh-token-rotation.md)
- [session-revocation](session-revocation.md)
<!-- used-by:end -->
