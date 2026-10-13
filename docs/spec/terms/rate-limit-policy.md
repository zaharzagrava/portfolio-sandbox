---
id: rate-limit-policy
title: Rate limit policy
kind: term
status: draft
aliases: [policy]
defined_for: rate-limit-policy
rules_hash: b7bbd82fcf48
---
# Rate limit policy
## Definition
A rate limit policy is a named rule that limits how often one caller (such as a user, client or key) may use a route or a code path. It declares an algorithm ([token bucket ↗](../sw-external-terms.md#token-bucket), [sliding window ↗](../sw-external-terms.md#sliding-window) or [concurrency](concurrency-limit.md)), a `limit`, a `windowMs` and a [`failMode`](rate-limit-fail-mode.md) of `open` or `closed`. Every capability that limits traffic uses policies the same way, so decisions, headers and errors look the same everywhere. A `429` response never includes the policy name.

## Example
Policy `discovery.recommendations` in S34 allows 600 requests per minute per address. Request 601 gets `429` `rate_limited` with a [`Retry-After` ↗](../sw-external-terms.md#retry-after) header.

## Known gaps
- The spec does not give the `limit` or `windowMs` for the S01 policies (`auth.register.ip`, `auth.login.ip`, `auth.login.account`, `auth.refresh.ip`, `auth.reset.ip`, `auth.reset.account`).
- The spec does not say which algorithm most capabilities' policies use.
- The spec lists S02, S03, S33, S35, S51, S54, W01, W02, W03 and W07 as users of policies but does not say how they use them.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-11
- [S32](../capabilities/S32-product-search.md): R-12
- [S50](../capabilities/S50-rate-limiter.md): R-03, R-15, B-01, B-03, B-06, B-07, B-08, B-10, B-13, B-20
- [batch-shops-lookup](batch-shops-lookup.md)
- [client-address](client-address.md)
- [concurrency-limit](concurrency-limit.md)
- [failures-only-policy](failures-only-policy.md)
- [fallback-token-bucket](fallback-token-bucket.md)
- [forwarding-headers](forwarding-headers.md)
- [get-trending](get-trending.md)
- [hash-tag](hash-tag.md)
- [http-surface](http-surface.md)
- [in-process-port](in-process-port.md)
- [known-gaps](known-gaps.md)
- [login-throttle](login-throttle.md)
- [nestjs-module](nestjs-module.md)
- [post-shops](post-shops.md)
- [rate-limit-bucket](rate-limit-bucket.md)
- [rate-limit-budget](rate-limit-budget.md)
- [rate-limit-check](rate-limit-check.md)
- [rate-limit-cost-exceeded](rate-limit-cost-exceeded.md)
- [rate-limit-cost-resolver](rate-limit-cost-resolver.md)
- [rate-limit-decorator](rate-limit-decorator.md)
- [rate-limit-exemption](rate-limit-exemption.md)
- [rate-limit-policy-change](rate-limit-policy-change.md)
- [rate-limit-policy-registry](rate-limit-policy-registry.md)
- [rate-limit-subject-fallback](rate-limit-subject-fallback.md)
- [rate-limit-subject](rate-limit-subject.md)
- [rate-limiter-service](rate-limiter-service.md)
- [shop-product-search-route](shop-product-search-route.md)
- [sliding-window-estimate](sliding-window-estimate.md)
- [sso-controller](sso-controller.md)
- [store-clock](store-clock.md)
- [subject-extractor](subject-extractor.md)
- [time-to-full](time-to-full.md)
- [trusted-proxy](trusted-proxy.md)
- [window-ms](window-ms.md)
<!-- used-by:end -->
