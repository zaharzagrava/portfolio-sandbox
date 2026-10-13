---
id: failures-only-policy
title: Failures-only policy
kind: term
status: draft
aliases: [count failures only, failures only]
defined_for: S50-rate-limiter
rules_hash: 4cfc4efed6d0
---
# Failures-only policy
## Definition
A failures-only policy counts only failed attempts, for example wrong credentials, and not successful ones. When the [budget](rate-limit-budget.md) is spent, every further request is denied with `429` before its [handler](job-handler.md) runs, even a request that would have succeeded. [The slot is reserved when the request is admitted](slot-budget.md), so many attempts sent in parallel cannot all pass a check made before the handler. It is meant for routes such as login, where [brute-force guessing ↗](../sw-external-terms.md#brute-force-attack) is the threat.

## Example
Take the policy "[5 per 15 min](rate-limit-policy.md)". A client sends five wrong passwords and then the correct one. The sixth request gets `429` and the login handler does not run. If 20 wrong-credential requests arrive in parallel, exactly 5 reach the handler.

## Known gaps
- The spec does not say how a failure is detected, for example by response status or by a thrown error.
- The spec does not say what happens to the reserved slot when the attempt succeeds. It is probably returned, but this is not confirmed in the code.
- The spec does not give the option name that makes a policy failures-only, and it states no rule for this kind of policy (only behaviors B-15 to B-17).

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): B-15
- [define-policies](define-policies.md)
- [job-handler](job-handler.md)
- [rate-limit-budget](rate-limit-budget.md)
- [rate-limit-policy-registry](rate-limit-policy-registry.md)
- [rate-limit-policy](rate-limit-policy.md)
- [reset-on-success](reset-on-success.md)
- [slot-budget](slot-budget.md)
<!-- used-by:end -->
