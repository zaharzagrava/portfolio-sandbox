---
id: rate-limit-policy-registry
title: Rate limit policy registry
kind: term
status: draft
aliases: [policy registry]
defined_for: S50-rate-limiter
rules_hash: 2fd78e866160
---
# Rate limit policy registry
## Definition
The policy registry is where the application keeps every [rate limit policy](rate-limit-policy.md), each under a unique name. Each capability declares its own policies with [`definePolicies`](define-policies.md) and registers them through the rate-limit module's [`forFeature`](define-policies.md). There is no central policy table. The rate-limit infrastructure registers only the default policies, `default.read` and `default.write`. If two modules declare the same policy name, [startup validation](startup-validation.md) fails and names both modules.

Design intent (not stated in the spec): a policy is declared next to the code it protects, so the owning team can change its limits without editing shared infrastructure.

## Example
A login capability declares a [failures-only policy](failures-only-policy.md) "5 per 15 min" named `auth.login` (illustrative name), with [`failMode: 'closed'`](rate-limit-fail-mode.md) (illustrative), through `definePolicies` and `forFeature`. Allowed responses on that route then carry:
```
RateLimit-Policy: "auth.login";q=5;w=900
```
If a second module also declared `auth.login`, the application would refuse to start.

## Known gaps
- The spec does not state the policy-name grammar as a rule. AS-69 tests it, but the page lists it only under known gaps.
- The spec does not say what happens when a route names a policy that no module registered. AS-72 tests that this is rejected at compile time, but the page has no rule for it.
- Not confirmed in the code: whether the registry itself rejects a policy without a `failMode`, or whether that check happens somewhere else.

## Used by
<!-- used-by:start -->
- [define-policies](define-policies.md)
- [failures-only-policy](failures-only-policy.md)
- [rate-limit-policy](rate-limit-policy.md)
- [startup-validation](startup-validation.md)
<!-- used-by:end -->
