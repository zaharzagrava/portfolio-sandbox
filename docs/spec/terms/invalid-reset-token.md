---
id: invalid-reset-token
title: invalid_reset_token (400)
kind: term
status: draft
aliases: [invalid_reset_token]
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# invalid_reset_token (400)
## Definition
`invalid_reset_token` is the error code that [`POST /auth/password-reset/confirm`](password-reset.md) returns with `400` when the [reset token](password-reset-token.md) can't be used. An unknown, [spent](spent-token.md) or expired token all get the same answer. This means a caller can't tell which case happened. Because of that, the response doesn't reveal whether a token ever existed, which is design intent (not stated in the spec). A weak new password is a different case: it returns `422` and the token stays usable.

## Example
```http
POST /auth/password-reset/confirm  → 400
Content-Type: application/problem+json

{"code": "invalid_reset_token", "requestId": "req-123"}
```
([`requestId`](request-id.md) value is illustrative and matches the `X-Request-Id` response header.)

## Known gaps
- The spec does not say how long a reset token stays valid before it expires.
- The spec does not list the other members of the [problem body](problem-body.md), such as `title` or `detail`.

## Used by
<!-- used-by:start -->
- [password-reset-link-invalidation](password-reset-link-invalidation.md)
- [password-reset-token](password-reset-token.md)
- [problem-body](problem-body.md)
- [spent-token](spent-token.md)
<!-- used-by:end -->
