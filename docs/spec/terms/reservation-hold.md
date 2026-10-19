---
id: reservation-hold
title: Hold and hold expiry
kind: term
status: draft
aliases: [hold, hold expiry]
defined_for: J03-launch-day
rules_hash: 5f844aecc78c
---
# Hold and hold expiry
## Definition
A hold reserves [scarce stock](catalog-stock.md) for one buyer for a limited time before the purchase is final. In a [launch event](launch-event.md), a buyer holds seats with the [admission token](admission-token.md) and then confirms the hold to get [bookings](booking-set.md). If an unconfirmed seat hold reaches its expiry, its seats become free again. A later confirm answers [`409 HOLD_EXPIRED`](booking-hold-expired.md) and creates no booking, event, notice or [voucher](voucher.md). In a [flash-sale drop](drop.md), an unpaid drop order is also a hold: when it lapses, its units are released once and the order becomes [`CANCELLED(hold_expired)`](hold-expired.md).

## Example
A buyer holds a seat and never confirms. After 10 minutes the seat is free again, and the late confirm answers `409 HOLD_EXPIRED` (J03.B-05). Neither the hold nor its expiry puts an item in the buyer's inbox (J03.R-16).

## Known gaps
- The spec does not say how "holds and expiries produce no inbox item" (J03.R-16) fits with a lapsed drop hold that notifies the buyer (J03.R-08, J03.B-09). The likely reading is that the silent rule covers seat holds only, but this is not confirmed.
- The spec does not give the route or request shape for creating or confirming a hold.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
