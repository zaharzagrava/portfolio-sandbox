---
id: mfa-state
title: MFA state (none, pending, enabled)
kind: term
status: draft
aliases: [enabled, pending, second-factor state, state `pending`]
defined_for: S02-mfa-oidc
rules_hash: 70bae24b8412
---
# MFA state (none, pending, enabled)
## Definition
The MFA state is the [second-factor status ↗](../sw-external-terms.md#mfa) of one user, and it is always exactly one of `none`, `pending` or `enabled`. `none` means the user has no second factor. `pending` means [enrolment](mfa-enrolment) has started but no code has been confirmed yet. `enabled` means login needs a [TOTP code ↗](../sw-external-terms.md#totp) or a [recovery code](mfa-recovery-code.md). [`GET /auth/mfa`](mfa-management-endpoint.md) returns the state, and the response never includes a secret, URI, stored hashed form of a recovery code, or any code.

## Example
The user calls enrol, so the state goes `none→pending`. They confirm with a current code (`pending→enabled`) and later disable the factor (`enabled→none`). If they wait too long before confirming, the [pending expiry](mfa-pending-expiry) passes and `GET /auth/mfa` reports `none`.

## Known gaps
- The spec does not say why [linking an account by e-mail](identity-link.md) moves the state from `enabled` to `none`. It only says that it does.
- The spec does not say whether an expired `pending` record gets deleted, or whether it is only reported as `none`.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): B-09
- [S02](../capabilities/S02-mfa-oidc.md): R-01, R-16, R-25, B-01, B-02, B-21, B-24
- [S48](../capabilities/S48-bff.md): B-15
- [W01](../capabilities/W01-auth-account.md): B-10
- [identity-link](identity-link.md)
- [login-mfa-page](login-mfa-page.md)
- [mfa-already-enabled](mfa-already-enabled.md)
- [mfa-challenge-token](mfa-challenge-token.md)
- [mfa-confirm](mfa-confirm.md)
- [mfa-management-endpoint](mfa-management-endpoint.md)
- [mfa-not-enabled](mfa-not-enabled.md)
- [mfa-recovery-code](mfa-recovery-code.md)
- [mfa-recovery-codes-regenerated-event](mfa-recovery-codes-regenerated-event.md)
- [mfa-recovery-digest](mfa-recovery-digest.md)
- [oidc-account-link](oidc-account-link.md)
- [otpauth-uri](otpauth-uri.md)
- [post-auth-login](post-auth-login.md)
- [post-bff-session](post-bff-session.md)
- [session-controller](session-controller.md)
<!-- used-by:end -->
