---
id: define-policies
title: definePolicies
kind: term
status: draft
aliases: [forfeature]
defined_for: S50-rate-limiter
rules_hash: e3b0c44298fc
---
# definePolicies
## Definition
`definePolicies` is the function a capability calls to declare the [rate limit policies](rate-limit-policy) it owns. It feeds the [policy registry](rate-limit-policy-registry.md), together with the rate-limit module's `forFeature`. Each owner declares its own policies here, and there is no central table. The rate-limit infrastructure owns only `default.read` and `default.write`. Every declared policy must state its [fail mode](rate-limit-fail-mode), either `open` or `closed`, and there is no default. A policy name declared in two modules makes [startup validation](startup-validation) fail.

## Example
A login capability declares a [failures-only policy](failures-only-policy.md) `auth.login` (illustrative name): limit 5, [`windowMs`](window-ms.md) 900000 (15 minutes), `failMode: 'closed'`, registered through `forFeature`. Allowed responses on that route then carry:
```
[RateLimit-Policy: "auth.login";q=5;w=900](rate-limit-response-headers.md)
```

## Known gaps
- The spec does not say what `definePolicies` accepts or returns. Its exact fields, and how a policy picks [token bucket ↗](../sw-external-terms.md#token-bucket), [sliding window ↗](../sw-external-terms.md#sliding-window) or concurrency, are not stated on the page.
- The spec does not state the policy-name grammar, or the compile-time rejection of undeclared names, as rules. Both are tested (AS-69, AS-72) but appear only under known gaps.
- Not confirmed in the code: whether `definePolicies` itself rejects a missing `failMode`, or whether that check happens elsewhere.

## Used by
<!-- used-by:start -->
- [failures-only-policy](failures-only-policy.md)
- [rate-limit-policy-registry](rate-limit-policy-registry.md)
<!-- used-by:end -->
