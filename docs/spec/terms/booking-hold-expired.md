---
id: booking-hold-expired
title: HOLD_EXPIRED (409)
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# HOLD_EXPIRED (409)
## Definition
`HOLD_EXPIRED` is the conflict answer to a [confirm](booking-confirm.md) on a [hold](booking-hold.md) that has already passed its expiry. By then the hold's seats have been freed. The refused confirm produces no booking, no [`launch_events.booking_confirmed`](launch-events-booking-confirmed-event.md), no notice and no [voucher](voucher.md). The expiry itself creates no [inbox item](inbox-item.md) either.

## Example
A buyer holds a seat and waits 10 minutes before confirming. The seat is free again, and the answer is:
```
409 HOLD_EXPIRED
```
(J03 AS-05)

## Known gaps
- The spec does not say whether this answer uses the [shared problem body](problem-body.md). It is also written in upper case, unlike codes such as `out_of_stock`.
- The spec does not name the confirm route that returns it.

## Used by
<!-- used-by:start -->
- [booking-confirm](booking-confirm.md)
- [booking-hold](booking-hold.md)
- [inbox-item](inbox-item.md)
- [problem-body](problem-body.md)
- [voucher](voucher.md)
<!-- used-by:end -->
