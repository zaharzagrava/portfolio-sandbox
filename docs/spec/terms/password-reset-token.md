---
id: password-reset-token
title: Password reset token
kind: term
status: draft
aliases: [e-mailed token, reset token]
defined_for: S01-auth-sessions
rules_hash: 9d3a84eea33b
---
# Password reset token
## Definition
A password reset token is the single-use secret e-mailed to a user who asked for a password reset at `POST /auth/password-reset/request`. The user sends it to `POST /auth/password-reset/confirm` together with a new password that passes the [password policy](password-problem.md). A successful confirm changes the password and [ends all of the user's sessions](session-revocation.md). After that, [the token is spent](spent-token.md), and sending it again gives `400`. The scheduled job [`auth.purge-reset-tokens`](auth-purge-reset-tokens-job.md) runs daily to remove old reset tokens.

## Example
A user requests a reset and receives the token by e-mail. They call `POST /auth/password-reset/confirm` with that token and a strong password. The password changes and every session is revoked. Sending the same token again returns `400`.

## Known gaps
- The spec does not say how long a reset token stays valid, or which tokens the purge job removes.
- The spec does not say the error code in the `400` body for a spent token, or whether the request endpoint avoids revealing whether an account exists.
- Not confirmed in the code: whether a successful confirm emits `identity.password_changed`. The event exists, but the facts do not link it to this flow.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): B-27
- [auth-purge-reset-tokens-job](auth-purge-reset-tokens-job.md)
- [in-memory-mailbox](in-memory-mailbox.md)
- [invalid-reset-token](invalid-reset-token.md)
- [malformed-queue-message](malformed-queue-message.md)
- [password-problem](password-problem.md)
- [password-reset-link-invalidation](password-reset-link-invalidation.md)
- [password-reset](password-reset.md)
- [raw-token](raw-token.md)
- [reset-token-jobs](reset-token-jobs.md)
- [session-revocation](session-revocation.md)
- [spent-token](spent-token.md)
- [template-redaction](template-redaction.md)
<!-- used-by:end -->
