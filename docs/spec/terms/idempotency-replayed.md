---
id: idempotency-replayed
title: Idempotency-Replayed header
kind: term
status: draft
aliases: [idempotency-replayed]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# Idempotency-Replayed header
## Definition
`Idempotency-Replayed` is a response header on [`POST /checkout`](post-checkout.md). It is set to `true` when the server returns a [stored answer](idempotency-stored-answer.md) instead of running checkout again. This happens when the same buyer resends the same [idempotency key](idempotency-key.md) with the same body. It lets a client tell a retry from a new checkout. No second order is created.

## Example
The buyer retries a completed checkout with the same key and the same body:
```
HTTP/1.1 202 Accepted
Location: /orders/<orderId>      (illustrative)
Idempotency-Replayed: true
```

## Known gaps
- The spec does not say whether the header is missing or set to `false` on the first, non-replayed answer.
- The spec does not say whether stored error answers, such as [`422 out_of_stock`](out-of-stock-error.md) after an order exists, are also replayed with this header.
- The spec does not say how long stored answers are kept before the [purge job](idempotency-purge-job.md) removes them.

## Used by
<!-- used-by:start -->
- [idempotency-key](idempotency-key.md)
- [idempotency-purge-job](idempotency-purge-job.md)
- [idempotency-stored-answer](idempotency-stored-answer.md)
<!-- used-by:end -->
