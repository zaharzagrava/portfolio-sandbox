---
id: webhook-retry-job
title: Webhook retry job
kind: term
status: draft
aliases: [retry job]
defined_for: J02-seller-to-first-sale
rules_hash: 91bbf8e40e7f
---
# Webhook retry job
## Definition
The webhook retry job is a scheduled job that sends a [webhook delivery](webhook-redelivery.md) again after the receiving endpoint failed to accept it. The first failed attempt does not lose the event, and the retry job delivers it later. A retried delivery must not cause a [duplicate effect ↗](../sw-external-terms.md#idempotency) on the shop's side. Design intent (not stated in the spec): the retry runs as a job so that a slow or failing receiver does not block the [webhook router](webhook-router.md).

## Example
The receiver `R` is set to answer `500`, and a buyer pays an order. The first delivery attempt of `order.paid` fails. The retry job delivers it later, and the shop records one paid order, not two (J02 AS-27).

## Known gaps
- The spec does not say the retry count, the [backoff ↗](../sw-external-terms.md#exponential-backoff) between attempts, or what happens after the last attempt fails.
- The spec does not say how the "no duplicate effect" is achieved, for example a stable event id the receiver can [deduplicate](callback-deduplication.md) on.
- Not confirmed in the code: the facts give no code excerpt for AS-27 beyond the scenario text.

## Used by
<!-- used-by:start -->
- [callback-deduplication](callback-deduplication.md)
- [webhook-endpoint](webhook-endpoint.md)
- [webhook-redelivery](webhook-redelivery.md)
- [webhook-router](webhook-router.md)
<!-- used-by:end -->
