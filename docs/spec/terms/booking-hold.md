---
id: booking-hold
title: Hold (booking hold)
kind: term
status: draft
aliases: [holds, unconfirmed hold]
defined_for: J03-launch-day
rules_hash: 16e836712242
---
# Hold (booking hold)
## Definition
A hold is a buyer's temporary claim on seats of a [launch event](launch-event-status.md), made before the booking exists. The buyer creates it on the hold route with the [admission token](admission-token.md). The hold route refuses an [ordinary access token](access-token.md), another event's token or another buyer's token. Confirming the hold turns it into [bookings](booking-set.md). An unconfirmed hold frees its seats at expiry, and a later confirm is refused with [HOLD_EXPIRED](booking-hold-expired).

## Example
A buyer leaves the queue with an admission token, holds seats, then confirms. That writes the bookings, [`launch_events.booking_confirmed`](launch-events-booking-confirmed-event.md) and the [voucher command](voucher-command.md). If the buyer does nothing for 10 minutes, the seat is free again and the confirm answers [`409 HOLD_EXPIRED`](booking-hold-expired.md) (J03 AS-05).

## Known gaps
- The spec does not say how long a hold lasts as a setting. The 10 minutes comes only from a test scenario.
- The spec does not name the hold or confirm routes, or their request bodies.
- The spec does not say how a seat freed at expiry interacts with a [`SOLD_OUT`](sold-out.md) event.

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): R-01, R-02, R-04
- [access-token](access-token.md)
- [admission-token](admission-token.md)
- [booking-hold-expired](booking-hold-expired.md)
- [booking-set](booking-set.md)
- [control-surface](control-surface.md)
- [launch-event-status](launch-event-status.md)
- [launch-events-booking-confirmed-event](launch-events-booking-confirmed-event.md)
- [no-notification-list](no-notification-list.md)
- [sold-out](sold-out.md)
- [voucher-command](voucher-command.md)
- [voucher](voucher.md)
<!-- used-by:end -->
