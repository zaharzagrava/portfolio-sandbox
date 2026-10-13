---
id: signing-key-states
title: Signing key states (NEXT, ACTIVE, RETIRED)
kind: term
status: draft
aliases: [active key, next key, retired key]
defined_for: S01-auth-sessions
rules_hash: 02dc5af5a19a
---
# Signing key states (NEXT, ACTIVE, RETIRED)
## Definition
Every [ES256 ↗](../sw-external-terms.md#jwt-alg) key that signs [access tokens](access-token.md) is in one of three states: NEXT, ACTIVE or RETIRED. Exactly one key is ACTIVE, and it signs new tokens. This holds even when several first uses [race on an empty key store ↗](../sw-external-terms.md#race-condition). [The JWKS ↗](../sw-external-terms.md#jwks) publishes the public part of all three states. The scheduled job [`auth.rotate-signing-keys`](key-rotation-job.md) moves keys between states.

Why NEXT and RETIRED keys are published is design intent (not stated in the spec):
- NEXT keys are published early so verifiers already have them cached when they become ACTIVE.
- RETIRED keys stay published so tokens signed earlier still verify until they expire.

## Example
```json
{"keys": [
  {"kid": "k-2026-10-14", "kty": "EC", "crv": "P-256", "alg": "ES256", "x": "…", "y": "…"},
  {"kid": "k-2026-10-13", "kty": "EC", "crv": "P-256", "alg": "ES256", "x": "…", "y": "…"},
  {"kid": "k-2026-10-12", "kty": "EC", "crv": "P-256", "alg": "ES256", "x": "…", "y": "…"}
]}
```
These are the NEXT, ACTIVE and RETIRED keys in that order. All `kid` values are illustrative, and the state itself is not shown in the JWKS. A token whose `kid` is not listed gets `401 invalid_token`.

## Known gaps
- The spec does not say when a RETIRED key is removed from the JWKS.
- The spec does not say how long a key stays NEXT before it becomes ACTIVE.
- The spec does not say where the private keys are stored or how they are protected.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-32, R-33, R-34, B-23, B-24
- [access-token](access-token.md)
- [key-retirement-grace-period](key-retirement-grace-period.md)
- [key-rotation-job](key-rotation-job.md)
- [signing-key-store](signing-key-store.md)
- [signing-key](signing-key.md)
- [verifier-key-cache](verifier-key-cache.md)
<!-- used-by:end -->
