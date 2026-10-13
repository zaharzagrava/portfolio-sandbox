---
id: internal-endpoint
title: Internal endpoint
kind: term
status: draft
aliases: [internal endpoints]
defined_for: S01-auth-sessions
rules_hash: 18cb156e5b3d
---
# Internal endpoint
## Definition
An internal endpoint is an HTTP route meant for other backend capabilities, not for browsers or end users. It is protected by `ServiceAuthGuard` and must be called with a [service-to-service token](service-to-service-token.md) from an allowed caller. To act for a user, a service calls [`exchange`](token-exchange.md), which turns the user's live [access token](access-token.md) into a token naming both the user and the calling service. `exchange` refuses the token of a [revoked session](session-revocation.md).

## Example
A call that presents a buyer's access token directly gets `401`. A call with a service token from a caller outside [`@AllowedCallers`](allowed-callers-decorator.md) gets `403 service_caller_not_allowed`.

## Known gaps
- The spec does not list which internal endpoints exist, their path prefix, or whether they are also isolated at the network level.
- The spec does not say which service exposes `exchange`. `ServiceTokenService` is the likely owner, but this is not confirmed.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-38, B-25
- [access-token](access-token.md)
- [allowed-callers-decorator](allowed-callers-decorator.md)
- [service-auth-guard](service-auth-guard.md)
- [service-caller-not-allowed](service-caller-not-allowed.md)
- [service-to-service-token](service-to-service-token.md)
- [session-revocation](session-revocation.md)
<!-- used-by:end -->
