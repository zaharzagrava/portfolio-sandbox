---
id: idempotency-key
title: Idempotency-Key header
kind: term
status: draft
aliases: [idempotency key, idempotency-key, the key]
defined_for: idempotency-key
rules_hash: 49dd241caadb
---
# Idempotency-Key header
## Definition
`Idempotency-Key` is a request header holding a string that the client chooses. When the client repeats a write with the same key, the request takes effect only once: no second order, charge or job. The client keeps one key for all retries of [one attempt](checkout-attempt.md). A repeated request with the same key still counts toward the cap on how many requests the route accepts in a given time.

## Example
```http
POST /checkout
Idempotency-Key: 7c1e9a42-5b3d-4f8e-a0c6-2d9f1b8e7a10   (illustrative value)
```
If this exact request is sent again with the same key, the client still gets one order.

## Known gaps
- The spec does not say the length limit applies to any route other than `POST /checkout`.
- The spec does not say how long a key is remembered before the [purge job](idempotency-purge-job.md) removes it. After that point, a retry might create a second effect.
- The spec does not say what happens when the same key is sent with a different request body.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-12, R-13, B-07, B-08
- [S13](../capabilities/S13-payment-intents.md): R-08, R-10, B-01, B-02
- [S49](../capabilities/S49-job-scheduler.md): R-06
- [W03](../capabilities/W03-cart-checkout-orders.md): R-09, R-11, B-14, B-16
- [job-scheduler-lease](../concepts/job-scheduler-lease.md): C-03
- [cart-empty](cart-empty.md)
- [checkout-attempt](checkout-attempt.md)
- [checkout-in-progress](checkout-in-progress.md)
- [checkout-unavailable](checkout-unavailable.md)
- [concurrency-limit](concurrency-limit.md)
- [correction-path](correction-path.md)
- [cron-fire-key](cron-fire-key.md)
- [idempotency-in-flight](idempotency-in-flight.md)
- [idempotency-key-conflict-error](idempotency-key-conflict-error.md)
- [idempotency-key-required](idempotency-key-required.md)
- [idempotency-purge-job](idempotency-purge-job.md)
- [idempotency-replayed](idempotency-replayed.md)
- [idempotency-store](idempotency-store.md)
- [idempotency-stored-answer](idempotency-stored-answer.md)
- [idempotency-unavailable](idempotency-unavailable.md)
- [idempotent-decorator](idempotent-decorator.md)
- [job-enqueue](job-enqueue.md)
- [job-retries](job-retries.md)
- [mutating-route](mutating-route.md)
- [out-of-stock-error](out-of-stock-error.md)
- [payment-already-exists](payment-already-exists.md)
- [platform-toolkit](platform-toolkit.md)
- [post-checkout](post-checkout.md)
- [price-changed](price-changed.md)
- [rate-limit-counter-store](rate-limit-counter-store.md)
- [rate-limit-decorator](rate-limit-decorator.md)
- [rate-limit-response-headers](rate-limit-response-headers.md)
- [rate-limit](rate-limit.md)
- [scheduler-leader](scheduler-leader.md)
- [scheduler-tick](scheduler-tick.md)
- [search-backfill-shop-state](search-backfill-shop-state.md)
- [unknown-payment-outcome](unknown-payment-outcome.md)
<!-- used-by:end -->
