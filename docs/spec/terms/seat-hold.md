---
id: seat-hold
title: Seat hold
kind: term
status: draft
aliases: [hold seats, holds]
defined_for: J03-launch-day
rules_hash: b3a7526232bc
---
# Seat hold
## Definition
A seat hold reserves one or more seats of a [launch event](launch-event.md) for a buyer before booking. The buyer must present a valid admission token to create it. Otherwise the hold route answers `403 ADMISSION_REQUIRED`. Confirming the hold writes the bookings, `launch_events.booking_confirmed` and a voucher command in one transaction. If the hold is not confirmed in time, its seats are freed at expiry, and a late confirm answers [`409 HOLD_EXPIRED`](seat-hold-expired.md) with no booking, event, notice or voucher.

## Example
A buyer holds a seat and does not confirm it for 10 minutes. The seat becomes free again, and the confirm answers:
```
409 HOLD_EXPIRED
```
Confirming the same hold several times, with one key or with different keys, returns the same [`bookingId`s](booking-id.md).

## Known gaps
- The spec does not say what the hold lifetime is configured as. The 10 minutes come only from scenario J03.B-05.
- The spec does not say how many seats one hold may cover.
- Not confirmed in the code: the routes used to create and confirm a hold. The facts list no routes.

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): B-01, B-05
- [admission-token](admission-token.md)
- [admitter](admitter.md)
- [booking-confirm](booking-confirm.md)
- [booking-confirmed-notification](booking-confirmed-notification.md)
- [booking-id](booking-id.md)
- [buyer-queue](buyer-queue.md)
- [seat-hold-expired](seat-hold-expired.md)
- [voucher](voucher.md)
<!-- used-by:end -->
