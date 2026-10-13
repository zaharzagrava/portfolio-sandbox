---
id: verifier-key-cache
title: Verifier key cache
kind: term
status: draft
aliases: [cache, cached key set]
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# Verifier key cache
## Definition
The verifier key cache is the set of public signing keys that a token verifier keeps after reading the [JWKS ↗](../sw-external-terms.md#jwks). It holds the public parts of the [NEXT, ACTIVE and RETIRED keys](signing-key-states.md). Because the keys are cached, the verifier does not have to fetch the key set for every request. To check an access token, the verifier finds the key whose [`kid` ↗](../sw-external-terms.md#jwt-kid) matches the token's `kid` in this cache. If no cached key matches, a [forced key-set reload](key-set-forced-reload.md) is tried before the token is rejected with [`invalid_token`](invalid-token-error.md).

The JWKS lists NEXT keys before they become ACTIVE. This is likely so that caches already hold a new key when tokens start using it. That is design intent (not stated in the spec).

## Example
A [stock verifier](stock-verifier.md) is set up only from `GET /.well-known/jwks.json` and caches the answer, which carries these headers:
```
[Cache-Control: public, max-age=300, stale-while-revalidate=3600 ↗](../sw-external-terms.md#cache-control)
[ETag: "jwks-v42" ↗](../sw-external-terms.md#etag)            (illustrative)
```
When it checks again, it sends `If-None-Match: "jwks-v42"`. If the keys have not changed, it gets `304` and keeps its cached key set.

## Known gaps
- The spec does not say which component holds the cached key set inside the backend, or whether it is filled from the signing key store or from the JWKS endpoint.
- The spec does not say how long the in-process cache keeps keys. The JWKS `Cache-Control` values apply to HTTP caches and stock verifiers.
- The spec does not say whether verifiers in other services follow the same cache and reload behaviour.

## Used by
<!-- used-by:start -->
- [key-set-forced-reload](key-set-forced-reload.md)
- [signing-key-states](signing-key-states.md)
- [stock-verifier](stock-verifier.md)
<!-- used-by:end -->
