---
id: nestjs-module
title: Module
kind: term
status: draft
aliases: [modules]
defined_for: S50-rate-limiter
rules_hash: f9c2d316757f
---
# Module
## Definition
A module is a unit of the backend application that groups the code of one capability. In rate limiting, a module is where a capability declares the [policies](rate-limit-policy.md) it owns. It does this with [`definePolicies`](define-policies.md) and the rate-limit module's [`forFeature`](define-policies.md). Policy names must be unique across all modules. If two modules declare the same name, [startup validation](startup-validation) stops the application and names both modules.

## Example
An orders capability's module declares the policy `orders.create` (illustrative name) through `definePolicies` and `forFeature`. A second module declares `orders.create` too. Startup fails, and the error names both modules (S50.B-20).

## Known gaps
- Not confirmed in the code: that these are NestJS modules. The `forFeature` name and the interceptor-based [`@RateLimit` decorator](rate-limit-decorator.md) suggest it, but the facts never name the framework.
- The spec does not say what the rate-limit module's `forFeature` does beyond taking part in policy registration.

## Used by
<!-- used-by:start -->
- [rate-limit-decorator](rate-limit-decorator.md)
- [rate-limit-policy](rate-limit-policy.md)
- [startup-validation](startup-validation.md)
<!-- used-by:end -->
