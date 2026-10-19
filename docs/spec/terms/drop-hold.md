---
id: drop-hold
title: Drop hold
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: 55e81e68a687
---
# Drop hold
## Definition
A drop hold is the reservation of [drop units](auction-unit.md) that a successful checkout creates; the checkout answers [`202 RESERVED`](reserved-answer.md). If the buyer does not pay in time, [the hold lapses](reservation-hold.md). When it lapses, the job [`orders.expire-reservation`](orders-expire-reservation-job.md) cancels the order as [`CANCELLED(hold_expired)`](hold-expired.md). The units go back to the drop once, and the buyer is notified. Paid units always stay sold.

## Example
A drop has 15 orders that are reserved but unpaid. After 15 minutes pass, all 15 orders become `CANCELLED(hold_expired)`, their units return, and each buyer is told (J03.B-09). A retried checkout with the same [idempotency key](idempotency-key.md) still creates only one order and one hold (J03.R-17).

## Known gaps
- The spec does not name the notification type the buyer receives when a hold lapses. J03.R-16 lists "holds and expiries" as silent, which appears to mean seat holds only.
- The spec does not say whether the hold duration is configurable.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
