---
id: verify-access-token
title: verifyAccessToken
kind: term
status: draft
aliases: []
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# verifyAccessToken
## Definition
`verifyAccessToken` is the identity-domain function that decides whether an access token can be trusted. It rejects a token with `alg: none`, a forged algorithm, an unknown `kid`, a bad `typ`, or a time outside the clock skew tolerance. Every one of these failures produces the same `401 invalid_token` body, so a caller cannot learn which check failed. It looks only at the token itself. Revoked sessions are refused at once only on a sensitive route, by a separate guard.

## Example
Three requests reach a protected route: one token has `alg: none`, one has an unknown `kid`, and one has expired. Each gets `401 invalid_token`, and the three bodies match except for `requestId` (S01.B-17):
```json
{"code": "invalid_token", "requestId": "req-123"}
```
(Illustrative body: the facts name only the `invalid_token` code and the `requestId` difference.)

## Known gaps
- The spec does not say what `verifyAccessToken` returns when a token is valid, for example whether it builds the principal itself or leaves that to the calling guard.
- The spec does not say whether `verifyAccessToken` checks the token's audience against the configured audience allowlist.
- Not confirmed in the code: that `verifyAccessToken` never checks session revocation. This page infers it from S01.R-17, which gives the immediate revocation check to `SensitiveSessionGuard` and lets an ordinary route accept the token until `exp`.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
