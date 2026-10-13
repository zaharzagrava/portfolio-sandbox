---
id: mfa-enrolment
title: MFA enrolment
kind: term
status: draft
aliases: [enroll, re-enrolling]
defined_for: S02-mfa-oidc
rules_hash: 4f31622936d3
---
# MFA enrolment
## Definition
Enrolment is how a signed-in user starts setting up [TOTP ↗](../sw-external-terms.md#totp). It is done with `POST /auth/mfa/enroll`. The call creates a new secret and returns it as an [otpauth URI](otpauth-uri.md) and a [manual key](manual-entry-key.md), which the user adds to an authenticator app. It moves the [MFA state](mfa-state) to [`pending`](mfa-state.md). Calling it again while `pending` replaces the secret and restarts the [pending expiry](mfa-pending-expiry). It never touches a factor that is already [`enabled`](mfa-state.md).

## Example
A user in state `none` calls `POST /auth/mfa/enroll` and gets back `200` with [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store):
```json
{ "otpauthUri": "otpauth://totp/...", "manualEntryKey": "JBSWY3DPEHPK3PXP" }
```
(The values are illustrative.) The user then calls [confirm](mfa-confirm) with a code from the app.

## Known gaps
- The spec does not say what the otpauth URI contains, such as the issuer label or the account name.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-02, B-01
- [manual-entry-key](manual-entry-key.md)
- [mfa-not-pending](mfa-not-pending.md)
- [mfa-pending-expiry](mfa-pending-expiry.md)
- [mfa-state](mfa-state.md)
- [otpauth-uri](otpauth-uri.md)
- [second-factor-model](second-factor-model.md)
<!-- used-by:end -->
