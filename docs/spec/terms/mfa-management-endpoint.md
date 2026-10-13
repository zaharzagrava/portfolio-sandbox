---
id: mfa-management-endpoint
title: MFA management endpoint
kind: term
status: draft
aliases: [management endpoints]
defined_for: S02-mfa-oidc
rules_hash: e372f43b9c32
---
# MFA management endpoint
## Definition
An MFA management endpoint is a route a signed-in user calls to view or change their own [second factor](mfa-state.md). These routes are status, enrol, confirm, regenerate [recovery codes](mfa-recovery-code.md) and disable, all under `/auth/mfa`. They need a [full session credential](session-cookie.md). If the credential is missing, or the caller sends as the Bearer the short-lived token given after only the password step of sign-in, they answer `401`. Disabling the factor or regenerating recovery codes also needs a fresh code, so a stolen [access token](access-token.md) alone cannot remove the second factor.

## Example
`POST /auth/mfa/disable` sent with the challenge token from a half-finished login as `Authorization: Bearer <challenge>` gets `401`. The same call with a real session and a current TOTP code removes the factor.

## Known gaps
- The spec does not say whether `POST /auth/mfa/verify` counts as a management endpoint. It accepts a challenge, so it is probably not one, but no rule says so.
- The spec does not say whether these endpoints accept both the Bearer access token and the `__Host-access` cookie, or only one of them.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-06
- [access-token](access-token.md)
- [mfa-challenge-token](mfa-challenge-token.md)
- [mfa-not-enabled](mfa-not-enabled.md)
- [mfa-recovery-code-regenerate](mfa-recovery-code-regenerate.md)
- [mfa-recovery-code](mfa-recovery-code.md)
- [mfa-state](mfa-state.md)
- [session-cookie](session-cookie.md)
- [unknown-body-field](unknown-body-field.md)
<!-- used-by:end -->
