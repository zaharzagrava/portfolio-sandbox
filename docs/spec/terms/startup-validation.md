---
id: startup-validation
title: Startup validation
kind: term
status: draft
aliases: [refuses to start, startup fails]
defined_for: S50-rate-limiter
rules_hash: ec1feeeab052
---
# Startup validation
## Definition
Startup validation is a set of checks the application runs on its [rate-limit setup](../capabilities/S50-rate-limiter.md) while it boots, before it serves any request. If a check fails, the application refuses to start rather than run with a broken setup. The spec names two checks. A [rate limit exemption](rate-limit-exemption) must have a non-blank reason. A [rate limit policy](rate-limit-policy) name must not be declared in two [module](nestjs-module.md)s. When a duplicate name is found, the startup error names both modules. Design intent (not stated in the spec): failing at boot surfaces mistakes in deployment, not as wrong limits in production traffic.

## Example
Two modules each declare a policy with the same name through [`definePolicies`](define-policies.md) and `forFeature`. The policy name `orders.create` is illustrative. Startup fails, and the error names both modules (S50.B-20).
[`@RateLimitExempt('')`](rate-limit-exemption.md) on a route also stops the application from starting (S50.B-19).

## Known gaps
- The spec does not say whether other mistakes are caught at startup. A policy without a declared [`failMode`](rate-limit-fail-mode.md) (S50.R-16) is one example.
- The spec does not say which error type or message startup validation raises, beyond the duplicate-name error naming both modules.
- The spec does not say which checks run at startup and which run at compile time. Policy-name grammar and rejection of undeclared names (AS-69, AS-72) are listed only as a known gap.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-07, B-16
- [bootstrap-app](bootstrap-app.md)
- [graceful-shutdown-drain](graceful-shutdown-drain.md)
- [hard-shutdown-timeout](hard-shutdown-timeout.md)
- [nestjs-module](nestjs-module.md)
- [rate-limit-exemption](rate-limit-exemption.md)
- [rate-limit-policy-registry](rate-limit-policy-registry.md)
- [request-drain-timeout](request-drain-timeout.md)
<!-- used-by:end -->
