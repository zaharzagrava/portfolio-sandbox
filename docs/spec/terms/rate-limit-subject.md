---
id: rate-limit-subject
title: Rate limit subject
kind: term
status: draft
aliases: [subject]
defined_for: rate-limit-policy
rules_hash: 7b5df0ba5895
---
# Rate limit subject
## Definition
A rate limit subject is the thing whose usage a [policy](rate-limit-policy.md) counts. It can be an address, a user, an API key, a shop or a hashed e-mail. Under each policy, each subject's usage is counted separately from every other subject's. A [`429` response ↗](../sw-external-terms.md#http-429-too-many-requests) never names the subject in its fields.

## Example
[S05](../capabilities/S05-products.md) counts writes per shop. S34 counts recommendation requests per address. [S32](../capabilities/S32-product-search.md) counts searches per user or per address.

## Known gaps
- The spec does not say which subject is used when a request has both a user and an address, as in S32's "per user or address".
- The spec does not say how the e-mail is hashed before it is used as a subject.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-09
- [S32](../capabilities/S32-product-search.md): R-12
- [S33](../capabilities/S33-autocomplete.md): R-16
- [S50](../capabilities/S50-rate-limiter.md): R-03, R-15, B-01, B-07, B-09, B-13, B-14
- [rate-limit-policy](../concepts/rate-limit-policy.md): C-02, C-04
- [acquire](acquire.md)
- [client-address](client-address.md)
- [concurrency-lease-release](concurrency-lease-release.md)
- [concurrency-lease](concurrency-lease.md)
- [fallback-token-bucket](fallback-token-bucket.md)
- [hash-tag](hash-tag.md)
- [http-surface](http-surface.md)
- [rate-limit-bucket](rate-limit-bucket.md)
- [rate-limit-budget](rate-limit-budget.md)
- [rate-limit-check](rate-limit-check.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit-subject-fallback](rate-limit-subject-fallback.md)
- [rate-limiter-service](rate-limiter-service.md)
- [reset-on-success](reset-on-success.md)
- [sliding-window-estimate](sliding-window-estimate.md)
- [subject-extractor](subject-extractor.md)
- [time-to-full](time-to-full.md)
<!-- used-by:end -->
