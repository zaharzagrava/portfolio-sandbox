---
id: buyer-queue
title: Buyer queue
kind: term
status: draft
aliases: [queue]
defined_for: J03-launch-day
rules_hash: ffc7f0f3dcf8
---
# Buyer queue
## Definition
The buyer queue is the waiting line that buyers join for a [launch event](launch-event.md) before they can book [seats](seat.md). Buyers in the queue wait until the admitter runs while sales are open. When admitted, a buyer receives an admission token bound to that event and that buyer. Joining the queue does not [hold](seat-hold.md) any seat.

## Example
Twelve buyers join the queue of a launch event before sales open. Once the event is [`ON_SALE`](launch-event-status.md), the admitter runs and each buyer receives a ticket (J03.B-01).

## Known gaps
- The spec does not say in what order buyers are admitted, for example first come, first served.
- The spec does not say where the queue is stored or which route a buyer uses to join it.
- The spec does not say what happens to buyers still queued when the event becomes `SOLD_OUT`.

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): B-01
- [admission-token](admission-token.md)
- [admitter](admitter.md)
- [launch-event](launch-event.md)
- [seat-hold](seat-hold.md)
- [seat](seat.md)
<!-- used-by:end -->
