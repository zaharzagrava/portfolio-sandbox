---
id: launch-event-status
title: Launch event status
kind: term
status: draft
aliases: [on_sale, sold_out]
defined_for: J03-launch-day
rules_hash: 2663525ad304
---
# Launch event status
## Definition
The [launch event](launch-event.md) status is the lifecycle state of a launch event: `SCHEDULED`, `ON_SALE`, `SOLD_OUT` or `CLOSED`. The sales-time job, the last booking and the organizer move it. The booking that takes the last seat moves the event from `ON_SALE` to `SOLD_OUT` exactly once, even when several [confirms](booking-confirm.md) race.

## Example
An event has one seat left and five buyers confirm at the same moment. Exactly one confirm takes the seat. The event becomes `SOLD_OUT` once (J03 AS-04).

## Known gaps
- The spec does not list the legal transitions, for example whether the organizer moves `ON_SALE` to `CLOSED`.
- The spec does not say whether an expired hold freeing a seat can move `SOLD_OUT` back to `ON_SALE`.
- The spec does not name the sales-time job.

## Used by
<!-- used-by:start -->
- [booking-confirm](booking-confirm.md)
- [booking-hold](booking-hold.md)
- [launch-event](launch-event.md)
<!-- used-by:end -->
