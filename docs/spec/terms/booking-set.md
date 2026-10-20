---
id: booking-set
title: Booking set
kind: term
status: draft
aliases: [bookings]
defined_for: J03-launch-day
rules_hash: 4b21b5f5350e
---
# Booking set
## Definition
A booking set is the group of bookings created by confirming one hold, one per held seat. Each booking has a [`bookingId`](booking-id.md). Any number of [confirms](booking-confirm.md) of the same hold must produce one booking set and return the same ids. This holds for repeated confirms with the same [key](idempotency-key.md) and for simultaneous confirms with different keys. Accepting different keys is design intent (not stated in the spec): it guards against a client that retries with a new key.

## Example
A buyer confirms one hold five times at once with one key and ten more times with other keys. All fifteen answers carry the same `bookingId`s, and only one booking set exists (J03 AS-03).

## Known gaps
- The spec does not say how concurrent confirms with different keys are made to converge, for example with a [unique constraint ↗](../sw-external-terms.md#unique-constraint) on the hold or a [conditional update](conditional-transition.md).
- The spec does not give the answer's shape beyond the `bookingId`s.

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): R-02
- [booking-confirm](booking-confirm.md)
- [booking-hold](booking-hold.md)
- [conditional-transition](conditional-transition.md)
- [idempotency-key](idempotency-key.md)
- [launch-events-booking-confirmed-event](launch-events-booking-confirmed-event.md)
- [reservation-hold](reservation-hold.md)
- [sold-out](sold-out.md)
- [voucher-command](voucher-command.md)
- [voucher](voucher.md)
<!-- used-by:end -->
