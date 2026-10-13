---
id: invalid-mfa-challenge
title: invalid_mfa_challenge (401)
kind: term
status: draft
aliases: [invalid_mfa_challenge]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# invalid_mfa_challenge (401)
## Definition
`invalid_mfa_challenge` is the error code that the [MFA verify endpoint](mfa-verify-endpoint.md) returns for any problem with the [MFA challenge](mfa-challenge.md) itself, as opposed to the code the user typed. It covers a challenge that is expired, tampered with, [issued for another audience ↗](../sw-external-terms.md#jwt-aud), already used, [burned](mfa-challenge-spent-burned.md) after too many wrong codes, or belonging to a deleted user. Every one of these cases gets the same answer. Design intent (not stated in the spec): a single answer stops a caller from learning why the challenge failed. A wrong [TOTP ↗](../sw-external-terms.md#totp) or [recovery code](mfa-recovery-code.md) with a valid challenge gets [`invalid_mfa_code`](invalid-mfa-code.md) instead.

## Example
A user signs in with a password, waits until the challenge has expired, then sends the current code to `POST /auth/mfa/verify`:
```
HTTP/1.1 401
{ "code": "invalid_mfa_challenge", ... }
```
No session is issued. The user has to log in again to get a new challenge.

## Known gaps
- The spec does not say whether the [`__Host-mfa-challenge` cookie](mfa-challenge-token.md) is cleared on every `invalid_mfa_challenge` answer. It only says the cookie is cleared once the challenge is spent or burned.
- The spec does not say whether an `invalid_mfa_challenge` answer counts toward the per-user wrong-code limit that leads to `429 rate_limited`.

## Used by
<!-- used-by:start -->
- [mfa-challenge-spent-burned](mfa-challenge-spent-burned.md)
- [mfa-challenge-token](mfa-challenge-token.md)
- [mfa-challenge](mfa-challenge.md)
- [mfa-recovery-code](mfa-recovery-code.md)
- [mfa-verify-endpoint](mfa-verify-endpoint.md)
<!-- used-by:end -->
