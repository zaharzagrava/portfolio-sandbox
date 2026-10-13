---
id: token-exchange
title: Token exchange
kind: term
status: draft
aliases: [exchange]
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# Token exchange
## Definition
Token exchange is how a backend capability turns a user's [access token](access-token.md) into a token for calling another service on that user's behalf. The new token keeps the user as [`sub` ↗](../sw-external-terms.md#jwt-sub) and names the calling service in [`act.sub` ↗](../sw-external-terms.md#jwt-act), in the [`svc:<caller>`](service-to-service-token.md) form. It also carries the user's [session ID](session-id.md), so the session stays tied to the call chain. If that session has been [revoked](session-revocation.md), the exchange fails instead of issuing a token. Design intent (not stated in the spec): the receiving service can tell who the user is and which service is acting for them.

## Example
`core` exchanges a user token with a live session, with `worker` as the [audience ↗](../sw-external-terms.md#jwt-aud). The resulting token claims are shown below (values are illustrative):
```json
{ "sub": "user-123", "act": { "sub": "svc:core" }, "aud": "worker", "sid": "sess-abc" }
```
After that session is revoked, the same `exchange` call throws.

## Known gaps
- Not confirmed in the code: which exported service provides `exchange`. [`ServiceTokenService`](service-to-service-token.md) is likely, but the facts do not name it.
- The spec does not say the claim name for the session ID, the lifetime of the exchanged token, or which error is thrown after revocation.
- The spec does not say how [`ServiceAuthGuard`](service-auth-guard.md) and [`@AllowedCallers(...)`](allowed-callers-decorator.md) check the exchanged token on the receiving side.

## Used by
<!-- used-by:start -->
- [access-token](access-token.md)
- [issuer-checks](issuer-checks.md)
- [session-id](session-id.md)
- [session-revocation](session-revocation.md)
<!-- used-by:end -->
