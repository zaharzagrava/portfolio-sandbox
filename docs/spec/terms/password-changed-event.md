---
id: password-changed-event
title: identity.password_changed event
kind: term
status: draft
aliases: [identity.password_changed]
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# identity.password_changed event
## Definition
`identity.password_changed` is an event that the [Identity domain](identity-domain.md) publishes when an account's password is replaced. The rule that records it covers confirming a [password reset](password-reset.md). In that same step, the password is replaced and [every session of the user is revoked](session-revocation.md) with reason [`password_reset`](session-revocation.md). Other domains can react to the event without calling [S01](identity-domain.md) directly. That decoupling is design intent (not stated in the spec).

## Example
A user calls `POST /auth/password-reset/confirm` with a valid token and an acceptable new password. S01 stores the new [password hash](password-hash.md) and revokes all the user's sessions with reason `password_reset`. It then records `identity.password_changed`.

## Known gaps
- The spec does not say what the event payload contains, such as which IDs or which timestamp.
- The spec does not say whether any flow other than reset confirmation emits this event.
- The spec does not say whether the event goes out through [the outbox](outbox-append.md) in the [same transaction ↗](../sw-external-terms.md#database-transaction) as the password change.

## Used by
<!-- used-by:start -->
- [identity-domain](identity-domain.md)
- [outbox-append](outbox-append.md)
- [password-hash](password-hash.md)
- [password-reset](password-reset.md)
- [session-revocation](session-revocation.md)
<!-- used-by:end -->
