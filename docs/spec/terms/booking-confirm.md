---
id: booking-confirm
title: Booking confirm
kind: term
status: draft
aliases: [confirm, confirmed, confirming]
defined_for: J03-launch-day
rules_hash: c29dd1afcb57
---
# Booking confirm
## Definition
A booking confirm turns a buyer's [seat hold](seat-hold.md) into a booking set. One transaction writes the bookings, the `launch_events.booking_confirmed` event and the voucher command, with no network call inside. Repeated or simultaneous confirms of the same hold return the same [`bookingId`s](booking-id.md) and create only one booking set. Confirming the last seat moves the launch event to `SOLD_OUT` exactly once. A confirm after the hold has expired is refused with HOLD_EXPIRED and produces no booking, event, notice or voucher.

## Example
A buyer holds seats with an admission token and then confirms the hold. The booking exists at once. The `notification-router` later adds one `booking.confirmed` inbox item, and orders issues one voucher (J03 AS-02). If those consumers are paused, the notice and voucher arrive after resume (J03 AS-06, AS-07).

## Known gaps
- The spec does not name the confirm route or the shape of its answer beyond the `bookingId`s.
- The spec does not say how the key is sent, or how simultaneous confirms with different keys converge on one booking set.

## Used by
<!-- used-by:start -->
- [booking-hold-expired](booking-hold-expired.md)
- [booking-set](booking-set.md)
- [launch-event-status](launch-event-status.md)
- [sold-out](sold-out.md)
<!-- used-by:end -->
