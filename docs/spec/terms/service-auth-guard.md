---
id: service-auth-guard
title: ServiceAuthGuard
kind: term
status: draft
aliases: []
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# ServiceAuthGuard
## Definition
`ServiceAuthGuard` is a [route guard](route-guard.md) exported by the [identity domain](identity-domain.md). It protects [internal endpoints](internal-endpoint.md) and accepts only valid [service-to-service tokens](service-to-service-token.md).

It answers `401` in four cases:
- the token is missing
- the token is expired
- the token has the [wrong audience ↗](../sw-external-terms.md#jwt-aud)
- the token is a [user's access token](access-token.md)

It answers [`403 service_caller_not_allowed`](service-caller-not-allowed.md) when the token is valid but the caller is not listed in the route's [`@AllowedCallers(...)`](allowed-callers-decorator.md).

## Example
```ts
@UseGuards(ServiceAuthGuard)        // wiring style illustrative
@AllowedCallers('orders')           // caller name illustrative
```
A valid service token from a caller other than `orders` gets `403 service_caller_not_allowed`.

## Known gaps
- The spec does not say how the token identifies its caller (which claim), or what the expected audience value is.
- The spec does not give the error code in the `401` body.

## Used by
<!-- used-by:start -->
- [access-token](access-token.md)
- [identity-domain](identity-domain.md)
- [internal-endpoint](internal-endpoint.md)
- [route-guard](route-guard.md)
- [service-to-service-token](service-to-service-token.md)
<!-- used-by:end -->
