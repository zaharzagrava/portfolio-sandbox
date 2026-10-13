---
id: idempotency-purge-job
title: Idempotency key purge job
kind: term
status: draft
aliases: [purge job]
defined_for: idempotency-key
rules_hash: 5db6e2ea0b29
---
# Idempotency key purge job
## Definition
The idempotency key purge job is a background job in the [platform toolkit](platform-toolkit.md) (S54). It deletes old [idempotency keys](idempotency-key.md) that the platform has stored. Without it, stored keys would keep growing forever. That reason is design intent (not stated in the spec). Once a key is purged, the platform no longer remembers the request it protected.

## Example
A client submits [`POST /checkout`](post-checkout.md) with `Idempotency-Key: 7f3c9a1e-checkout-attempt` (illustrative value). Retries with that key create no second order. Later, the purge job deletes the stored key. The spec does not give the delay.

## Known gaps
- The spec does not say when the purge job runs or how old a key must be before it is deleted.
- The spec does not say what happens when a client retries with a key that has already been purged. A late retry might create a second order, charge or job.
- The spec does not say whether the purge job also covers keys used for [job enqueue](job-enqueue.md) ([S49](../capabilities/S49-job-scheduler.md)).

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): B-18
- [apply-stock-delta](apply-stock-delta.md)
- [idempotency-key](idempotency-key.md)
- [idempotency-replayed](idempotency-replayed.md)
- [idempotency-store](idempotency-store.md)
- [idempotency-stored-answer](idempotency-stored-answer.md)
- [idempotent-decorator](idempotent-decorator.md)
- [job-enqueue](job-enqueue.md)
- [platform-toolkit](platform-toolkit.md)
- [product-stock-service](product-stock-service.md)
- [stock-operation-replayed](stock-operation-replayed.md)
<!-- used-by:end -->
