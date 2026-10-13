---
id: idempotency-in-flight
title: idempotency_in_flight (409)
kind: term
status: draft
aliases: [idempotency_in_flight]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# idempotency_in_flight (409)
## Definition
`idempotency_in_flight` is the conflict answer [`POST /checkout`](post-checkout.md) gives when a request arrives with an [Idempotency-Key](idempotency-key.md) that is still being processed. The first request with that key has not finished, so there is no [stored answer](idempotency-stored-answer.md) to replay yet. The answer carries a [`Retry-After` ↗](../sw-external-terms.md#retry-after) header. When the client retries after the first request finishes, it gets the stored answer back as a replay. Keys are scoped to the buyer, so only the same buyer's same key counts as a duplicate.

## Example
The buyer's browser sends `POST /checkout` with `Idempotency-Key: 7f3c9a10-checkout` (illustrative). The user double-clicks, and a second request with the same key arrives before the first one finishes:
```
HTTP/1.1 409 Conflict
Retry-After: 1
```

## Known gaps
- The spec does not say whether the body must also match for the duplicate to count as "in flight". It also does not say whether a different body sent during processing gets this answer or [`idempotency_key_reuse`](idempotency-key-reuse.md).
- The spec does not say how long a key can stay "in flight" if the first request's process crashes before it finishes.

## Used by
<!-- used-by:start -->
- [idempotency-key](idempotency-key.md)
- [idempotency-stored-answer](idempotency-stored-answer.md)
<!-- used-by:end -->
