---
id: delivery-id
title: Delivery id
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: c9d8a4a3dfac
---
# Delivery id
## Definition
The delivery id identifies one delivery: one notification, to one recipient, on one external channel. The cap decision, the wake job and the ["never send twice" guard](never-send-twice-guard.md) all key on it. Once the cap decision is made for a delivery id, that decision is final, so retries and [concurrent copies](concurrent-delivery-copies.md) cannot change it.

## Example
The cap admits a marketing push delivery with id `d-7f3a` (illustrative). Later a duplicate copy of `d-7f3a` asks the cap again. It gets the same admitted answer and [no extra slot is counted](slot-budget.md).

## Known gaps
- The spec does not say how the delivery id is built. It might be derived from the dedupe identity (source event id, recipient, channel) or generated separately.
- Not confirmed in the code: the format of the delivery id, or where it is stored.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-29
- [bounded-label-values](bounded-label-values.md)
- [capped-delivery](capped-delivery.md)
- [concurrent-delivery-copies](concurrent-delivery-copies.md)
- [delivery-capped](delivery-capped.md)
- [marketing-cap](marketing-cap.md)
- [marketing-delivery-cap](marketing-delivery-cap.md)
- [never-send-twice-guard](never-send-twice-guard.md)
- [notification-delivery](notification-delivery.md)
- [slot-budget](slot-budget.md)
<!-- used-by:end -->
