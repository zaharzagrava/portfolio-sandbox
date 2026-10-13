---
id: client-address
title: Client address (resolved by the platform)
kind: term
status: draft
aliases: [client address, resolved address]
defined_for: S50-rate-limiter
rules_hash: f63fb6d00d40
---
# Client address (resolved by the platform)
## Definition
The client address is the network address of the caller as the platform itself works it out, not as the client claims it. The limiter uses it as the [subject](rate-limit-subject.md) for [address-keyed policies](rate-limit-policy.md). It is also the [fallback subject](rate-limit-subject-fallback.md) when a policy keyed on a user, API key or shop gets a request without that identity. A client cannot get a fresh [budget](rate-limit-budget.md) by changing [forwarding headers](forwarding-headers.md) on its own requests. The reason is design intent (not stated in the spec): a client that could pick its own subject could get around every address-keyed limit.

## Example
A client sends three requests and changes `CF-Connecting-IP`, `X-Forwarded-For` and `X-Real-IP` each time (for example to `198.51.100.1`, `.2`, `.3`, illustrative). All three still count against one [bucket](rate-limit-bucket.md): the one for the address the platform resolved.

## Known gaps
- The spec does not say how the platform resolves the address, for example which proxies it trusts or which header it reads behind them.
- The spec does not say whether IPv6 addresses are grouped (for example by prefix) or used as a full address.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): B-12
- [forwarding-headers](forwarding-headers.md)
- [rate-limit-bucket](rate-limit-bucket.md)
- [rate-limit-budget](rate-limit-budget.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit-subject-fallback](rate-limit-subject-fallback.md)
- [rate-limit-subject](rate-limit-subject.md)
- [subject-extractor](subject-extractor.md)
<!-- used-by:end -->
