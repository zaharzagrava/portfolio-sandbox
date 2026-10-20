---
id: sold-out
title: SOLD_OUT
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# SOLD_OUT
## Definition
`SOLD_OUT` is a state of a [launch event](launch-event.md). It means every [seat](seat.md) is [booked](booking-set.md). The last [confirmed booking](booking-confirm.md) moves the event from [`ON_SALE`](launch-event-status.md) to `SOLD_OUT`. This transition must happen exactly once, even when several buyers confirm the last seat at the same moment. The other states are `SCHEDULED`, `ON_SALE` and `CLOSED`.

## Example
B-04: a launch event has one seat left and five buyers confirm their [holds](booking-hold.md) simultaneously. One booking wins, and the event becomes `SOLD_OUT` once, not five times.

## Known gaps
- The spec does not say whether a `SOLD_OUT` event can return to `ON_SALE`, for example when a booking is cancelled.
- The spec does not say whether reaching `SOLD_OUT` emits its own event or notification.

## Used by
<!-- used-by:start -->
- [booking-confirm](booking-confirm.md)
- [booking-hold](booking-hold.md)
- [booking-set](booking-set.md)
- [launch-event](launch-event.md)
- [seat](seat.md)
<!-- used-by:end -->
