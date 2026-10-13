---
id: mfa-verify-endpoint
title: MFA verify endpoint
kind: term
status: draft
aliases: [verify endpoint]
defined_for: S02-mfa-oidc
rules_hash: 8ce034864bfe
---
# MFA verify endpoint
## Definition
`POST /auth/mfa/verify` is the second step of a login for a user with an enabled factor. When the password login returns a [challenge](mfa-challenge.md), the client sends that challenge here with either a time-based one-time code from the user's authenticator app or a [recovery code](mfa-recovery-code.md). If both are valid, the endpoint issues the session with the [same login body as S01](../capabilities/S01-auth-sessions.md). [Per-IP throttling](rate-limit.md) runs before the request body is validated, so a malformed body still uses up the rate limit. When the session is sent to the browser in a cookie, the endpoint also checks the `Origin` header.

## Example
A user with MFA enabled logs in with a password and gets a challenge. They then send the current 6-digit code to `POST /auth/mfa/verify`. With cookie delivery and an allowed `Origin`, the answer sets three cookies and puts no token in the body. With `Origin: https://evil.example` it answers `403 origin_not_allowed`.

## Known gaps
- The spec does not say which rate limit policy runs here. The capability owns `auth.mfa.ip`, but the code does not confirm that this policy applies to this endpoint.
- The spec does not say exactly how the challenge reaches the endpoint (the `__Host-mfa-challenge` cookie, a body field, or both). The challenge cookie for federated logins (AS-54, AS-55) has no test with a scenario id.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-15
- [S48](../capabilities/S48-bff.md): B-16
- [W01](../capabilities/W01-auth-account.md): B-14
- [cookie-delivery](cookie-delivery.md)
- [mfa-challenge](mfa-challenge.md)
- [mfa-code](mfa-code.md)
- [mfa-recovery-code-spend](mfa-recovery-code-spend.md)
- [mfa-recovery-code-used-event](mfa-recovery-code-used-event.md)
- [mfa-recovery-code](mfa-recovery-code.md)
- [origin-allow-list](origin-allow-list.md)
- [origin-not-allowed](origin-not-allowed.md)
- [rate-limit](rate-limit.md)
<!-- used-by:end -->
