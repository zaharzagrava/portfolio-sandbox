---
id: allowed-callers-decorator
title: @AllowedCallers decorator
kind: term
status: draft
aliases: [@allowedcallers]
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# @AllowedCallers decorator
## Definition
`@AllowedCallers(...)` is a decorator you put on an [internal endpoint](internal-endpoint.md) to list which backend services may call it. [`ServiceAuthGuard`](service-auth-guard.md) reads that list after checking the [service-to-service token](service-to-service-token.md). A valid token from a service outside the list is refused with [`403` service_caller_not_allowed](service-caller-not-allowed.md). The decorator only controls which services get in; checking the token itself is the guard's job.

## Example
An internal endpoint protected by `ServiceAuthGuard` with `@AllowedCallers(...)` that names one calling service (illustrative). A request from that service with a valid token passes. A valid token from any other service gets `403 service_caller_not_allowed`. [A user's access token](access-token.md) gets `401`.

## Known gaps
- The spec does not say how caller names are written or where they come from (for example, a claim inside the service token).
- The spec does not say what happens to an endpoint that uses `ServiceAuthGuard` without `@AllowedCallers`: whether every service is allowed or every service is refused.
- Not confirmed in the code: the decorator's exact signature. Only `ServiceAuthGuard` is cited (`packages/backend/libs/domains/identity/api/guards/service-auth.guard.ts`).

## Used by
<!-- used-by:start -->
- [access-token](access-token.md)
- [internal-endpoint](internal-endpoint.md)
- [service-caller-not-allowed](service-caller-not-allowed.md)
- [service-to-service-token](service-to-service-token.md)
<!-- used-by:end -->
