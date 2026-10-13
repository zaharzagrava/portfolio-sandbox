---
id: service-caller-not-allowed
title: service_caller_not_allowed (403)
kind: term
status: draft
aliases: [service_caller_not_allowed]
defined_for: S01-auth-sessions
rules_hash: 5bbb056eb1da
---
# service_caller_not_allowed (403)
## Definition
`service_caller_not_allowed` is the error code an [internal endpoint](internal-endpoint.md) returns with `403` when a valid [service-to-service token](service-to-service-token.md) comes from the wrong caller. [`ServiceAuthGuard`](service-auth-guard.md) has already accepted the token, but the calling service is not in the endpoint's [`@AllowedCallers`](allowed-callers-decorator.md) list. A missing, expired, [wrong-audience ↗](../sw-external-terms.md#jwt-aud) or user token gets a `401` instead. So a `403` means "we know who you are, but you may not call this", and a `401` means "we could not establish who you are".

## Example
A service with a valid service token calls an internal endpoint whose `@AllowedCallers` does not include that service. The answer is:
```
HTTP/1.1 403
{"code": "service_caller_not_allowed", ...}
```
(The other [problem body members](problem-body.md) are left out here; the spec does not list them for this error.)

## Known gaps
- The spec does not say which problem body members come with this error, or whether the body names the rejected caller.
- The spec does not say whether rejected calls are logged or counted in a metric.

## Used by
<!-- used-by:start -->
- [allowed-callers-decorator](allowed-callers-decorator.md)
- [internal-endpoint](internal-endpoint.md)
- [problem-body](problem-body.md)
- [service-to-service-token](service-to-service-token.md)
<!-- used-by:end -->
