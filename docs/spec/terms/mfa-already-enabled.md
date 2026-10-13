---
id: mfa-already-enabled
title: mfa_already_enabled (409)
kind: term
status: draft
aliases: [mfa_already_enabled]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# mfa_already_enabled (409)
## Definition
`mfa_already_enabled` is the [conflict error](conflict-error) that [enrolment](mfa-enrolment) returns when the user's [MFA state](mfa-state) is already `enabled`. The call changes nothing: the secret, the [recovery codes](mfa-recovery-code.md) and the state all stay as they were. The spec says why: an enabled factor cannot be reset with an [access token](access-token) alone, so a stolen token cannot remove the [second factor ↗](../sw-external-terms.md#mfa). To start over, the user has to [disable the factor](mfa-state.md) first, and disabling needs a [TOTP code ↗](../sw-external-terms.md#totp) or an [unspent recovery code](mfa-recovery-code.md).

## Example
A user with MFA `enabled` calls [`POST /auth/mfa/enroll`](mfa-enrolment.md) and gets `409` with [error code](error-code) `mfa_already_enabled`. Their authenticator app and recovery codes keep working.

## Used by
<!-- used-by:start -->
- [mfa-recovery-code](mfa-recovery-code.md)
- [mfa-state](mfa-state.md)
<!-- used-by:end -->
