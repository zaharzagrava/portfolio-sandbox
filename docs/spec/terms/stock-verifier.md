---
id: stock-verifier
title: Stock verifier
kind: term
status: draft
aliases: []
defined_for: S01-auth-sessions
rules_hash: 9b57fa16926b
---
# Stock verifier
## Definition
The stock verifier is the standard access-token check that [protected routes](protected-route.md) use by default. It lives in the identity domain as [`verifyAccessToken`](verify-access-token.md). It rejects a token signed with [`alg: none` ↗](../sw-external-terms.md#jwt-alg) or a forged algorithm. It also rejects an unknown [`kid` ↗](../sw-external-terms.md#jwt-kid), a bad [`typ` ↗](../sw-external-terms.md#jwt-typ), or a time outside the [clock skew tolerance](clock-skew-tolerance.md). Every one of these failures gets the same `401 invalid_token` body, so a caller cannot tell which check failed.

## Example
Three requests reach a protected route through the stock verifier: one token has `alg: none`, one has an unknown `kid`, and one has expired. All three get `401 invalid_token`. The three response bodies are identical apart from `requestId` (S01.B-17).

## Known gaps
- The spec does not say what "stock" is contrasted with. It does not say whether other, non-standard verifiers exist or which routes would use them.
- Not confirmed in the code: that `packages/backend/libs/domains/identity/domain/token-verifier.ts#verifyAccessToken` is the exact component the behavior calls the "stock verifier". This page infers it because S01.R-15 lists the same failure cases and links to that code.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): B-17
- [clock-skew-tolerance](clock-skew-tolerance.md)
- [protected-route](protected-route.md)
- [verifier-key-cache](verifier-key-cache.md)
<!-- used-by:end -->
