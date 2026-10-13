---
id: key-set-forced-reload
title: Forced key-set reload
kind: term
status: draft
aliases: [forced reload]
defined_for: S01-auth-sessions
rules_hash: 3897210015a5
---
# Forced key-set reload
## Definition
A forced reload happens when a token carries a [`kid` ↗](../sw-external-terms.md#jwt-kid) that is missing from the verifier's cached [key set ↗](../sw-external-terms.md#jwks). Instead of rejecting the token at once, the verifier fetches the key set again, which picks up a key that was published recently. These reloads are [rate limited](rate-limit.md), so a stream of tokens with made-up `kid` values cannot trigger a flood of key fetches. The rate limit's purpose is design intent (not stated in the spec). If the `kid` is still unknown after the reload, the token is rejected with [`invalid_token`](invalid-token-error.md).

## Example
A token arrives with `kid: "k-7f3a"` (illustrative), and that key is not in the cache. The verifier reloads the key set once. A second unknown `kid` arriving within 30 s gets no reload and is answered `401 invalid_token`.

## Known gaps
- The spec does not say which component holds the cached key set, or whether it reloads from the [key store](signing-key-store.md) or from the JWKS endpoint.
- The spec does not say whether this limit also applies to verifiers in other services.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-35
- [rate-limit](rate-limit.md)
- [signing-key-store](signing-key-store.md)
- [verifier-key-cache](verifier-key-cache.md)
<!-- used-by:end -->
