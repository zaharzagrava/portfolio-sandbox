---
id: orders-expire-reservation-job
title: orders.expire-reservation job
kind: term
status: draft
aliases: [orders.expire-reservation]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# orders.expire-reservation job
## Definition
`orders.expire-[reservation](all-or-nothing-reservation.md)` is the orders job that lapses an unpaid reservation once its [hold expires](reservation-hold.md). The order becomes [`CANCELLED(hold_expired)`](hold-expired.md), its units are released once, and the buyer is notified. Paid orders are not affected, and their units stay sold. Time comes from the [injected clock](injected-clock.md), so tests can make a hold expire.

## Example
From J03.B-09: 15 [drop orders](drop.md) are reserved but not paid. When 15 minutes pass, each becomes `CANCELLED(hold_expired)`, its unit returns, and its buyer is told (J03.R-08, proof J03 AS-12, J03 AS-14).

## Known gaps
- The spec does not say whether this job also cancels an unpaid auction winner order after 48 hours (J03.B-16 gives that outcome but names no job).
- The spec does not say whether released units return to the drop or to catalog stock.
- The spec does not name the notification type the buyer receives.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
