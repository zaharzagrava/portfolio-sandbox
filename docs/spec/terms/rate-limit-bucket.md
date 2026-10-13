---
id: rate-limit-bucket
title: Rate limit bucket
kind: term
status: draft
aliases: [bucket, buckets]
defined_for: rate-limit-policy
rules_hash: 98a2f668daa4
---
# Rate limit bucket
## Definition
A rate limit bucket holds the remaining allowance, meaning how much more a client may still use, for one [rate limit subject](rate-limit-subject.md) under one [rate limit policy](rate-limit-policy.md). It lives in the [rate limit counter store](rate-limit-counter-store.md), so every instance reads and updates the same bucket. Each decision changes it in one [atomic step ↗](../sw-external-terms.md#atomic-increment). A bucket never shares its allowance with another subject or another policy.

## Example
The address `203.0.113.7` (illustrative) gets one bucket under [`auth.login.ip`](rate-limit-policy.md). If the same login also counts against `auth.login.account`, that account gets its own separate bucket. Using up one bucket does not touch the other.

## Known gaps
- The spec does not say how a bucket's key is built from the policy name and the subject.
- The spec does not say when an unused bucket expires or is removed from the shared store.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): R-03, B-02, B-14, B-16
- [rate-limit-policy](../concepts/rate-limit-policy.md): C-02
- [circuit-breaker-probe](circuit-breaker-probe.md)
- [client-address](client-address.md)
- [invalid-rate-limit-cost-error](invalid-rate-limit-cost-error.md)
- [rate-limit-check](rate-limit-check.md)
- [rate-limit-cost-exceeded](rate-limit-cost-exceeded.md)
- [rate-limit-cost](rate-limit-cost.md)
- [rate-limit-counter-store](rate-limit-counter-store.md)
- [rate-limit-policy-change](rate-limit-policy-change.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit-subject](rate-limit-subject.md)
- [store-clock](store-clock.md)
<!-- used-by:end -->
