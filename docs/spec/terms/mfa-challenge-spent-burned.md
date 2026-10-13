---
id: mfa-challenge-spent-burned
title: Challenge spent or burned
kind: term
status: draft
aliases: [burned, spent]
defined_for: S02-mfa-oidc
rules_hash: eaa627404b97
---
# Challenge spent or burned
## Definition
These are the two ways an [MFA challenge](mfa-challenge.md) stops being usable. It is "spent" when a [verify call](mfa-verify-endpoint.md) succeeds with it, because a challenge is single-use. It is "burned" when it has received too many wrong codes. In both cases a later use of the challenge gets [`401 invalid_mfa_challenge`](invalid-mfa-challenge.md). When verify uses the [challenge cookie](mfa-challenge-token.md), the server clears that cookie as soon as the challenge is spent or burned.

## Example
A user signs in with Google, and the server sets [`__Host-mfa-challenge`](host-bff-mfa-cookie.md). The user then sends 3 wrong codes to `POST /auth/mfa/verify`. The challenge is now burned and the cookie is cleared. A 4th attempt, even with the correct code, gets `401 invalid_mfa_challenge`.

## Known gaps
- The spec does not say whether the cookie is also cleared when the challenge simply expires.
- The spec does not say whether a [`429 rate_limited`](rate-limited.md) answer counts as a wrong attempt against the challenge.
- The spec does not say whether a `403 origin_not_allowed` answer uses up an attempt. The rule says only that the check runs "before touching the challenge", which suggests it does not.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-29
- [invalid-mfa-challenge](invalid-mfa-challenge.md)
- [mfa-challenge-token](mfa-challenge-token.md)
- [mfa-challenge](mfa-challenge.md)
- [mfa-verify-endpoint](mfa-verify-endpoint.md)
<!-- used-by:end -->
