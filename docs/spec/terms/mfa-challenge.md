---
id: mfa-challenge
title: MFA challenge
kind: term
status: draft
aliases: [challenge]
defined_for: S01-auth-sessions
rules_hash: 1e49b970dbc6
---
# MFA challenge
## Definition
An MFA challenge is what `POST /auth/login` returns in place of a [session](session-lifetime.md) when the user has enrolled a [second factor ↗](../sw-external-terms.md#mfa). The correct password does not create a session or issue tokens. The response instead holds `mfaRequired: true` and an [`mfaToken`](mfa-challenge-token.md). The client must then complete the second verification step, and only that step creates the session.

## Example
```
POST /auth/login  → 200
{"mfaRequired": true, "mfaToken": "<opaque token>"}
```
After this response, the user has no session.

## Known gaps
- The spec does not say how long the `mfaToken` stays valid, whether it can be used only once, or what format it has. S02 owns these details.
- The spec does not say whether a challenge resets the [per-address login counter](login-throttle.md) the way a successful login does.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-14
- [S02](../capabilities/S02-mfa-oidc.md): R-12, B-04
- [W01](../capabilities/W01-auth-account.md): R-13, B-13
- [invalid-mfa-code](invalid-mfa-code.md)
- [login-mfa-page](login-mfa-page.md)
- [login-page](login-page.md)
- [login-throttle](login-throttle.md)
- [mfa-recovery-code-used-event](mfa-recovery-code-used-event.md)
- [mfa-verify-endpoint](mfa-verify-endpoint.md)
- [post-auth-login](post-auth-login.md)
- [second-factor-model](second-factor-model.md)
- [session-lifetime](session-lifetime.md)
- [soft-deleted-user](soft-deleted-user.md)
<!-- used-by:end -->
