---
id: password-reset
title: Password reset
kind: term
status: draft
aliases: [password-reset request]
defined_for: S01-auth-sessions
rules_hash: cf961292c49f
---
# Password reset
## Definition
Password reset lets a user set a new password with a [single-use token](password-reset-token.md) instead of the old password. It has two steps: `POST /auth/password-reset/request` asks for a reset link, and `POST /auth/password-reset/confirm` uses the token. The request step always answers `202`, whether the address is unknown, belongs to a [passwordless account](passwordless-account.md), or belongs to an account with a password. Only that last case sends a message. Older links stop working ([reset link invalidation](password-reset-link-invalidation.md)), and the [raw token](raw-token.md) is never stored. The daily job [`auth.purge-reset-tokens`](auth-purge-reset-tokens-job.md) cleans up reset-token records.

## Example
```
POST /auth/password-reset/request
{"email": "buyer@example.com"}        (illustrative address)

→ 202
```
You get the same `202` for an address that has no account. A message is sent only when the account exists and has a password.

## Known gaps
- The spec does not say what `confirm` expects or returns, how long a token stays valid, or which errors it gives.
- The spec does not say whether a confirmed reset revokes existing sessions. It also does not say whether it emits [`identity.password_changed`](password-changed-event.md), although that event exists.
- The spec does not say whether the request endpoint is rate-limited.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-39, R-40
- [password-changed-event](password-changed-event.md)
- [password-reset-link-invalidation](password-reset-link-invalidation.md)
- [password-reset-token](password-reset-token.md)
- [passwordless-account](passwordless-account.md)
- [raw-token](raw-token.md)
<!-- used-by:end -->
