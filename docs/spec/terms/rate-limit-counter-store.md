---
id: rate-limit-counter-store
title: Rate limit counter store
kind: term
status: draft
aliases: [counter store, store that holds its counters]
defined_for: idempotency-key
rules_hash: 71c8dbd130d9
---
# Rate limit counter store
## Definition
The counter store is where the request limiter keeps its running counts, such as how many requests a client has made recently. The limiter reads and updates it on each request to decide whether the route's [rate limit](rate-limit.md) allows the request. Requests that carry an [idempotency key](idempotency-key.md) update the counters too, so retries are not free. When the store is unavailable, the limiter cannot decide, and the route's setting for what to do in that case decides instead. A store shared by all service instances keeps limits correct when there are several instances, which is design intent (not stated in the spec).

## Example
A route has a rate limit of 3. A client sends four identical requests with the same `Idempotency-Key`. Each request updates the counter in the counter store, so the fourth request gets `429` (rule idempotency-key.C-07).
```
request 1..3 -> counter 1..3 -> allowed
request 4    -> counter 4    -> 429
```

## Known gaps
- The spec does not say what technology backs the counter store. It also does not say whether all instances share one store or each process has its own.
- The spec does not say what each counter is keyed by (user, IP, route, or a mix). It also does not say how long counters live.
- The spec does not say how the store keeps counts correct under concurrent requests, for example with [atomic increments ↗](../sw-external-terms.md#atomic-increment).

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-16
- [S13](../capabilities/S13-payment-intents.md): R-09, R-26
- [S28](../capabilities/S28-notifications.md): R-29
- [S50](../capabilities/S50-rate-limiter.md): R-07, R-13
- [rate-limit-policy](../concepts/rate-limit-policy.md): C-03
- [circuit-breaker-probe](circuit-breaker-probe.md)
- [concurrency-lease](concurrency-lease.md)
- [fallback-token-bucket](fallback-token-bucket.md)
- [hash-tag](hash-tag.md)
- [idempotency-key](idempotency-key.md)
- [marketing-delivery-cap](marketing-delivery-cap.md)
- [rate-limit-bucket](rate-limit-bucket.md)
- [rate-limit-budget](rate-limit-budget.md)
- [rate-limit-fail-mode](rate-limit-fail-mode.md)
- [rate-limit-store-timeout-ms](rate-limit-store-timeout-ms.md)
- [rate-limit](rate-limit.md)
- [rate-limiter-service](rate-limiter-service.md)
- [rate-limiter-unavailable](rate-limiter-unavailable.md)
- [store-clock](store-clock.md)
- [time-to-full](time-to-full.md)
<!-- used-by:end -->
