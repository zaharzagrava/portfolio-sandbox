---
id: invalid-mfa-code
title: invalid_mfa_code (401)
kind: term
status: draft
aliases: [invalid_mfa_code]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# invalid_mfa_code (401)
## Definition
`invalid_mfa_code` is the error code returned at login when the [second-factor code](mfa-code.md) is wrong. Every wrong code gets the same `401` body: a wrong [TOTP code ↗](../sw-external-terms.md#totp), a [replayed TOTP code](totp-replay-protection.md), or an unknown or [spent recovery code](mfa-recovery-code-spend.md). The likely reason is that an attacker cannot tell which kind of code failed or why: design intent (not stated in the spec). Wrong codes count toward the [per-user lockout](login-throttle.md), which then returns `429 rate_limited`. They also count toward [burning the challenge](mfa-challenge.md).

## Example
A TOTP code was already accepted at step T, and a second login presents the same code to `POST /auth/mfa/verify`. The answer is `401` with error code `invalid_mfa_code`. A typo in a recovery code gets exactly the same body.

## Known gaps
- The spec does not say whether the management endpoints (confirm, regenerate, disable) use `invalid_mfa_code` for a wrong code. The rule covers only login.

## Used by
<!-- used-by:start -->
- [login-throttle](login-throttle.md)
- [mfa-challenge](mfa-challenge.md)
- [mfa-code](mfa-code.md)
- [mfa-recovery-code-spend](mfa-recovery-code-spend.md)
- [totp-replay-protection](totp-replay-protection.md)
<!-- used-by:end -->
