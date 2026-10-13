---
id: mfa-code
title: MFA code
kind: term
status: draft
aliases: [code, current code]
defined_for: S02-mfa-oidc
rules_hash: 60572ff7fa71
---
# MFA code
## Definition
An MFA code is the short numeric [TOTP code ↗](../sw-external-terms.md#totp) that the user's authenticator app shows for the [current time step](totp-time-step.md). It is accepted only for the current step or one step either side, and only if that step is later than the [last step accepted](totp-time-step.md) for that user. The last accepted step is stored durably, so a [replayed code](totp-replay-protection.md) stays rejected even after a cache flush or restart. At login, the system tells a TOTP code from a [recovery code](mfa-recovery-code.md) by its form; it does not try both. Wrong codes count toward a per-user limit shared by all endpoints.

## Example
A user in state `pending` sends the code their app currently shows to `POST /auth/mfa/confirm`, and the factor becomes `enabled`. If the same code is presented again at `POST /auth/mfa/verify`, the answer is `401 invalid_mfa_code`.

## Known gaps
- The spec does not name the JSON field that carries the code in request bodies.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): B-02
- [W01](../capabilities/W01-auth-account.md): R-14
- [invalid-code](invalid-code.md)
- [invalid-mfa-code](invalid-mfa-code.md)
- [mfa-recovery-code](mfa-recovery-code.md)
- [mfa-verify-endpoint](mfa-verify-endpoint.md)
- [totp-replay-protection](totp-replay-protection.md)
- [totp-time-step](totp-time-step.md)
- [verify-totp](verify-totp.md)
<!-- used-by:end -->
