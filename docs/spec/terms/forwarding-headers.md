---
id: forwarding-headers
title: Forwarding headers
kind: term
status: draft
aliases: [x-forwarded-for]
defined_for: S01-auth-sessions
rules_hash: 79d43c451612
---
# Forwarding headers
## Definition
Forwarding headers are request headers that a proxy adds to name the original client address. [S01](../capabilities/S01-auth-sessions.md) uses the client IP to count login requests for the [`auth.login.ip`](rate-limit-policy.md) [rate limit policy](rate-limit-policy.md). The service accepts the IP from these headers only when the direct peer is a proxy it has been configured to rely on. Otherwise it ignores them and uses the address of the connection. Without this rule a caller could avoid the per-IP limit by sending a different address in each request.

## Example
A client connects directly, not through a trusted proxy, and sends:
```
X-Forwarded-For: 203.0.113.7
```
The 21st login from the connection's own IP within a minute still gets [`429` ↗](../sw-external-terms.md#http-429-too-many-requests). The forged header does not reset the count. (Header name and address are illustrative.)

## Known gaps
- The spec does not say which forwarding headers are read (for example `X-Forwarded-For` or `Forwarded`), or which entry is used when a header lists several addresses.
- The spec does not say whether the same IP resolution applies to the `auth.register.ip`, `auth.refresh.ip` and `auth.reset.ip` policies. It says this only for login.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-10
- [client-address](client-address.md)
- [login-throttle](login-throttle.md)
- [rate-limit-policy](rate-limit-policy.md)
- [trusted-proxy](trusted-proxy.md)
<!-- used-by:end -->
