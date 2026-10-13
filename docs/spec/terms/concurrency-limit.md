---
id: concurrency-limit
title: Concurrency limit
kind: term
status: draft
aliases: []
defined_for: idempotency-key
rules_hash: 50122345350d
---
# Concurrency limit
## Definition
A concurrency limit is one of the kinds of [rate limit](rate-limit.md) offered by the system's rate limiting capability, alongside [token bucket ↗](../sw-external-terms.md#token-bucket) and [sliding window ↗](../sw-external-terms.md#sliding-window). It caps how many requests can be in progress at the same moment, while a token bucket or sliding window caps how many requests arrive over a period of time. When a request ends, its slot becomes free for the next one. This kind of limit also has a set behavior for what happens when the limit itself cannot be checked.

## Example
A route has a concurrency limit of 2 (an illustrative value; the spec does not name any route that uses one):
```
request A starts    -> allowed (1 in flight)
request B starts    -> allowed (2 in flight)
request C starts    -> rejected, the limit is full
request A finishes  -> a later request D is allowed
```

## Known gaps
- The spec does not say which routes use a concurrency limit, or what the limit is on each.
- The spec does not say what a rejected request gets back. A `429` is confirmed only for the rate limit on repeated [idempotency-key](idempotency-key.md) requests.
- The spec does not say what the limit is counted against (for example per user, per tenant or per instance). It also does not say how it differs from the [upstream in-flight limit](upstream-in-flight-limit.md).

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-12
- [S50](../capabilities/S50-rate-limiter.md): R-10, B-05
- [acquire](acquire.md)
- [bounded-concurrency](bounded-concurrency.md)
- [client-abort](client-abort.md)
- [concurrency-lease](concurrency-lease.md)
- [handler-timeout](handler-timeout.md)
- [hash-queue-limit](hash-queue-limit.md)
- [idempotency-key](idempotency-key.md)
- [password-hash](password-hash.md)
- [rate-limit-budget](rate-limit-budget.md)
- [rate-limit-fail-mode](rate-limit-fail-mode.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit](rate-limit.md)
- [retry-after-ms](retry-after-ms.md)
- [upstream-in-flight-limit](upstream-in-flight-limit.md)
- [window-ms](window-ms.md)
<!-- used-by:end -->
