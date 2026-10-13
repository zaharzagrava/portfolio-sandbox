---
id: signing-key
title: Signing key
kind: term
status: draft
aliases: [key rotation]
defined_for: S01-auth-sessions
rules_hash: d31c7bb1f1a0
---
# Signing key
## Definition
A signing key is the [ES256 ↗](../sw-external-terms.md#jwt-alg) key pair that S01 uses to sign access tokens. Each key has a [`kid` ↗](../sw-external-terms.md#jwt-kid) and is in one of three states: [NEXT, ACTIVE or RETIRED](signing-key-states.md). Exactly one key is ACTIVE at a time. [The JWKS ↗](../sw-external-terms.md#jwks) publishes only the public part of the NEXT, ACTIVE and RETIRED keys, so that any service can verify tokens. The scheduled job `auth.rotate-signing-keys` moves keys through these states and removes RETIRED keys once they are old enough.

## Example
An access token whose header says `{"alg":"ES256","kid":"k-2026-10-13"}` (illustrative `kid`) verifies against the matching entry in `GET /.well-known/jwks.json`. If the key behind a token's `kid` has left the JWKS, that token gets [`401 invalid_token`](invalid-token-error.md).

## Known gaps
- The spec does not say when a NEXT key becomes ACTIVE, or how long a key stays ACTIVE.
- The spec does not say how private keys are protected at rest. It is not confirmed whether [`SecretBox`](secret-box.md) is used for them.
- The spec says an unreadable signing key gives a generic `500` with no usable session. It does not say how the failure is detected or reported to operators.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-43
- [S10](../capabilities/S10-cart-checkout.md): R-25
- [auth-events-total](auth-events-total.md)
- [key-retirement-grace-period](key-retirement-grace-period.md)
- [key-rotation-job](key-rotation-job.md)
- [signing-key-states](signing-key-states.md)
<!-- used-by:end -->
