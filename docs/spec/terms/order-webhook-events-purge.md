---
id: order-webhook-events-purge
title: Webhook events purge
kind: term
status: draft
aliases: [purge]
defined_for: S10-cart-checkout
rules_hash: 41e5a6ac9a64
---
# Webhook events purge
## Definition
This is a daily job, `orders.purge-webhook-inbox`, that deletes stored [webhook events ↗](../sw-external-terms.md#webhook-event) from the payment provider once they are older than the [retention period](bounded-retention.md). It only touches events whose source is `stripe`; rows from any other source are left alone. The cutoff is strict: an event exactly at the retention age is kept, and anything older is removed. Like every orders job, running it twice, or on two instances at the same time, has the same effect as running it once.

## Example
The retention is 35 days. An event received exactly 35 days ago is kept. An event received 35 days and 1 s ago is deleted.

## Known gaps
- The spec does not say whether the purge looks at the event's stored status ([`REJECTED`](rejected-payment-event.md), [`UNMATCHED`](unmatched-payment-event.md), [`IGNORED`](ignored-payment-event.md), processed) or only at its age.
- The spec does not say how the system handles a provider [redelivery](webhook-redelivery.md) of an event ID that has already been purged. [Duplicate detection](verified-webhook-event.md) relies on the stored event, so the redelivery might not be recognised as a duplicate.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-45
- [bounded-retention](bounded-retention.md)
- [verified-webhook-event](verified-webhook-event.md)
- [webhook-redelivery](webhook-redelivery.md)
<!-- used-by:end -->
