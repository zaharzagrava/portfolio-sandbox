---
id: checkout-in-progress
title: checkout_in_progress (409)
kind: term
status: draft
aliases: [checkout_in_progress]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# checkout_in_progress (409)
## Definition
`checkout_in_progress` is the conflict answer [`POST /checkout`](post-checkout.md) gives when the buyer already has another checkout running under a different [Idempotency-Key](idempotency-key.md). Only one checkout per buyer can run at a time, and every other one is turned away until it finishes. This differs from [`idempotency_in_flight`](idempotency-in-flight.md), which covers a duplicate with the *same* key. Design intent (not stated in the spec): it stops two parallel checkouts from reserving stock for the same cart twice.

## Example
A buyer has two browser tabs open. Tab 1 sends `POST /checkout` with key `tab-one-key-01` and tab 2 sends key `tab-two-key-02` at the same moment (keys illustrative). One of them proceeds, and the other gets `409 checkout_in_progress`.

## Known gaps
- The spec does not say whether this answer includes a [`Retry-After` header ↗](../sw-external-terms.md#retry-after).
- The spec does not say how the [per-buyer lock ↗](../sw-external-terms.md#distributed-lock) is held, or when it is freed if a checkout crashes partway through.
- The spec does not say whether this rejection releases the second request's key so that key can be retried as is.

## Used by
<!-- used-by:start -->
- [idempotency-key](idempotency-key.md)
<!-- used-by:end -->
