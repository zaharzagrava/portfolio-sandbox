---
id: stock-jwt-verifier
title: Stock verifier (standard JWT library)
kind: term
status: draft
aliases: []
defined_for: S01-auth-sessions
rules_hash: 1cc94d557fd5
---
# Stock verifier (standard JWT library)
## Definition
A stock verifier is an off-the-shelf [JWT ↗](../sw-external-terms.md#jwt) library, not code written for this system. The only thing it is given is the published [JWKS ↗](../sw-external-terms.md#jwks). The rule uses it as a compatibility test: an [access token](access-token.md) must verify with nothing but `GET /.well-known/jwks.json` and the library's normal [ES256 ↗](../sw-external-terms.md#jwt-alg) checks. This lets other services or outside tools verify tokens without any custom identity code. That reason is design intent (not stated in the spec).

## Example
A service points a standard JWT library at `/.well-known/jwks.json`. When an access token arrives, the library takes its [`kid` ↗](../sw-external-terms.md#jwt-kid) from the header, finds the matching ES256 public key in the set and checks the signature. No call goes to S01.

## Known gaps
- The spec does not say which library the proof uses for the test.
- The spec does not say whether a stock verifier is expected to run the extra checks that [`verifyAccessToken`](verify-access-token.md) runs. These are the `typ` check, the clock skew tolerance and the `alg: none` rejection.
- The spec does not name the issuer or audience values a verifier should check.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-32
- [access-token](access-token.md)
<!-- used-by:end -->
