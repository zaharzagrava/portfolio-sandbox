---
id: key-retirement-grace-period
title: Key retirement grace period
kind: term
status: draft
aliases: [grace period, purged]
defined_for: S01-auth-sessions
rules_hash: 06980d9aa0e8
---
# Key retirement grace period
## Definition
The grace period is how long a [RETIRED](signing-key-states.md) [signing key](signing-key.md) is kept after it stops signing. During this time the key stays in the [JWKS ↗](../sw-external-terms.md#jwks), and access tokens it signed still verify. When the grace period ends, the key rotation job purges the key. After the purge, a token that carries that key's [`kid` ↗](../sw-external-terms.md#jwt-kid) is rejected with the usual `invalid_token`. Design intent (not stated in the spec): the grace period lets tokens issued just before a rotation keep working until their `exp`, so users are not signed out early.

## Example
Key A is retired by the daily `auth.rotate-signing-keys` run, and key B becomes ACTIVE. An access token signed by A a few seconds earlier still passes `verifyAccessToken`. After A is purged, for example 24 h after retirement (illustrative), the same token would get `401 invalid_token` (unknown `kid`, S01.R-15). In practice it would have expired well before then.

## Known gaps
- The spec does not say how long the grace period is. It also does not say whether the grace period must last longer than the access-token lifetime plus the JWKS cache time (`max-age` and `stale-while-revalidate`).
- The spec does not say whether verifiers that cached the JWKS before the purge keep accepting tokens signed by the purged key until their cache refreshes.
- Not confirmed in the code: whether the grace period is counted from the moment of retirement or from the key's last signature. It is also not confirmed whether a disabled rotation schedule stops RETIRED keys from being purged.

## Used by
<!-- used-by:start -->
- [key-rotation-job](key-rotation-job.md)
- [signing-key-states](signing-key-states.md)
- [signing-key](signing-key.md)
<!-- used-by:end -->
