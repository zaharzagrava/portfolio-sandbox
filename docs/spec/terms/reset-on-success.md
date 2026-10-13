---
id: reset-on-success
title: Reset on success
kind: term
status: draft
aliases: [resetonsuccess]
defined_for: S50-rate-limiter
rules_hash: 65dd501a9e88
---
# Reset on success
## Definition
Reset on success is an option on a [failures-only policy](failures-only-policy.md). When a request succeeds, it clears that [subject's](rate-limit-subject.md) [failure count](failure-counter.md). Earlier failures then no longer count against the next attempts. The reason is design intent (not stated in the spec): a user who mistypes a password a few times and then logs in should not stay close to being [locked out](login-throttle.md).

## Example
A subject has four failed logins counted. The fifth attempt has the correct password and succeeds. The policy has reset on success, so the count goes back to zero.

## Known gaps
- The spec does not give the option's name or where it is set.
- The spec does not say whether the reset affects only the policy that admitted the request or other policies on the same route too.
- The spec does not say how this relates to [the service method `reset`](rate-limiter-service.md), whose safety ([AS-58](acceptance-scenario.md) and AS-59) is not stated as a rule.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): B-16
- [acceptance-scenario](acceptance-scenario.md)
- [failure-counter](failure-counter.md)
- [failures-only-policy](failures-only-policy.md)
- [login-throttle](login-throttle.md)
- [rate-limit-subject](rate-limit-subject.md)
- [rate-limiter-service](rate-limiter-service.md)
<!-- used-by:end -->
