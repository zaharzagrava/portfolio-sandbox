---
id: trusted-proxy
title: Trusted proxy
kind: term
status: draft
aliases: [peer]
defined_for: S01-auth-sessions
rules_hash: 79d43c451612
---
# Trusted proxy
## Definition
A trusted proxy is a network peer, such as a [load balancer ↗](../sw-external-terms.md#load-balancer) or [reverse proxy ↗](../sw-external-terms.md#reverse-proxy), whose [forwarding headers](forwarding-headers.md) [S01](../capabilities/S01-auth-sessions.md) believes. The list of trusted proxies is part of S01's configuration. When a request comes from a trusted proxy, the client IP comes from the forwarding headers. For any other peer, the IP comes from the connection itself. [IP-based rate limit policies](rate-limit-policy.md) count requests by this IP.

## Example
The load balancer at `10.0.0.5` is configured as a trusted proxy and forwards `X-Forwarded-For: 198.51.100.20`. [The login IP limit](login-throttle.md) counts the request against `198.51.100.20`. The same header sent straight from the internet is ignored. (Addresses are illustrative.)

## Known gaps
- The spec does not say the format of the trusted-proxy setting (single IPs, CIDR ranges or hop count), its name, or its default value.
- The spec does not say how chains with several proxies are handled.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-10
- [forwarding-headers](forwarding-headers.md)
- [login-throttle](login-throttle.md)
- [rate-limit-policy](rate-limit-policy.md)
<!-- used-by:end -->
