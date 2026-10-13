---
id: idempotency-stored-answer
title: Stored answer
kind: term
status: draft
aliases: [stored answers, stored error answers]
defined_for: S10-cart-checkout
rules_hash: 8751cce5a147
---
# Stored answer
## Definition
The stored answer is the response that [`POST /checkout`](post-checkout.md) saved under a buyer's [idempotency key](idempotency-key.md). If the same buyer sends the same key with the same body again, the server returns this saved answer and does not run checkout again. The replayed response carries [`Idempotency-Replayed: true`](idempotency-replayed.md). Once an order exists, the stored answer is the final outcome for that key. If checkout fails before an order exists, the key is released and no answer is kept for it. The goal is that a client retry, for example after a network drop, never creates a second order. This is design intent (not stated in the spec).

## Example
A buyer's first checkout with key `k-123` (illustrative) answered `202` with a [`Location` header ↗](../sw-external-terms.md#location-header). The client resends the same key and body:
```
HTTP/1.1 202 Accepted
Location: /orders/<orderId>      (illustrative)
Idempotency-Replayed: true
```

## Known gaps
- The spec does not say which parts of the response are stored and replayed: status, body, every header, or only some of them.
- The spec does not say whether an error that comes after an order exists, such as [`422 out_of_stock`](out-of-stock-error.md) with a [`CANCELLED(out_of_stock)`](order-status.md) order, is stored and replayed in the same way.
- The spec does not say how long a stored answer is kept before the [idempotency key purge job](idempotency-purge-job.md) removes it.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): B-17
- [idempotency-in-flight](idempotency-in-flight.md)
- [idempotency-key-required](idempotency-key-required.md)
- [idempotency-key](idempotency-key.md)
- [idempotency-purge-job](idempotency-purge-job.md)
- [idempotency-replayed](idempotency-replayed.md)
- [idempotency-store](idempotency-store.md)
- [ledger-entry-table](ledger-entry-table.md)
- [payment-already-exists](payment-already-exists.md)
<!-- used-by:end -->
