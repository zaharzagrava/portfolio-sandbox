---
id: mfa-challenge-token
title: MFA challenge token
kind: term
status: draft
aliases: [challenge token]
defined_for: S02-mfa-oidc
rules_hash: 24897f3ee6b2
---
# MFA challenge token
## Definition
An MFA challenge token is the short-lived proof that a user passed the password step but not yet the [second factor](mfa-state.md). A password login for a user whose factor is [`enabled`](mfa-state.md) returns this token instead of a session. The user sends it to [`POST /auth/mfa/verify`](mfa-verify-endpoint.md) with a [TOTP ↗](../sw-external-terms.md#totp) or [recovery code](mfa-recovery-code.md), and the session is issued only then. The token can be used once, expires after a short time, and is burned after a few wrong codes. Every defect in it gives the same `401 invalid_mfa_challenge`.

## Example
Alice logs in with her password and gets a challenge. Her browser receives it in the `__Host-mfa-challenge` cookie. She sends her current 6-digit code to `POST /auth/mfa/verify` and gets the normal S01 login body. If the challenge is expired, tampered with, issued for another audience, or belongs to a deleted user, she gets `401 invalid_mfa_challenge`.

## Known gaps
- The spec does not say what format the token has. "Tampered" and "another audience" suggest a signed token with an audience claim, but this is not confirmed in the code.
- The spec does not say how non-cookie clients receive the challenge. The scenarios that cover the challenge cookie for federated logins (AS-54, AS-55) have no test.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-06
- [mfa-management-endpoint](mfa-management-endpoint.md)
- [mfa-recovery-code-regenerate](mfa-recovery-code-regenerate.md)
- [mfa-recovery-code](mfa-recovery-code.md)
- [mfa-state](mfa-state.md)
<!-- used-by:end -->
