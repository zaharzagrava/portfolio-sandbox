---
id: otpauth-uri
title: otpauthUri
kind: term
status: draft
aliases: []
defined_for: S02-mfa-oidc
rules_hash: c57bb704dd01
---
# otpauthUri
## Definition
`otpauthUri` is a field in the response of [`POST /auth/mfa/enroll`](mfa-enrolment.md). It is the standard `otpauth://` URI that authenticator apps read, usually from a QR code, to set up the [TOTP ↗](../sw-external-terms.md#totp) secret. It comes together with [`manualEntryKey`](manual-entry-key.md), for users who type the key in by hand. Because it contains the secret, the response is sent with [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store), and status responses never include it.

## Example
Response to enrol in state `none` (values are illustrative):
```json
{ "otpauthUri": "otpauth://totp/<label>?secret=<key>&...", "manualEntryKey": "<key>" }
```
Re-enrolling in [state `pending`](mfa-state.md) returns a new URI. Codes from the old one no longer confirm (S02.R-03).

## Known gaps
- The spec does not say the issuer, label or other parameters inside the URI.

## Used by
<!-- used-by:start -->
- [mfa-enrolment](mfa-enrolment.md)
- [mfa-recovery-digest](mfa-recovery-digest.md)
- [mfa-state](mfa-state.md)
<!-- used-by:end -->
