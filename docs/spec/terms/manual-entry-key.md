---
id: manual-entry-key
title: manualEntryKey
kind: term
status: draft
aliases: []
defined_for: S02-mfa-oidc
rules_hash: 7d39db0503a9
---
# manualEntryKey
## Definition
`manualEntryKey` is a field in the response of [`POST /auth/mfa/enroll`](mfa-enrolment.md), next to [`otpauthUri`](otpauth-uri.md). The user types it into an authenticator app when they cannot scan the otpauth URI as a QR code. The response that carries it is sent with [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store). Re-enrolling while the state is [`pending`](mfa-state.md) replaces the secret, so a key from an earlier enrol call stops working. Status responses never include it.

## Example
```http
POST /auth/mfa/enroll
→ 200  Cache-Control: no-store
{ "otpauthUri": "otpauth://totp/...", "manualEntryKey": "JBSWY3DPEHPK3PXP" }
```
(The URI and the key value are illustrative.)

## Known gaps
- The spec does not say how the key is encoded. In general practice it is the [TOTP secret ↗](../sw-external-terms.md#totp) written in [base32 ↗](../sw-external-terms.md#base32), but the facts do not confirm this.
- The spec does not say whether the key can be shown again after enrolment. Only re-enrolling in `pending` is described, and that issues a new secret.

## Used by
<!-- used-by:start -->
- [W01](../capabilities/W01-auth-account.md): R-19
- [mfa-enrolment](mfa-enrolment.md)
<!-- used-by:end -->
