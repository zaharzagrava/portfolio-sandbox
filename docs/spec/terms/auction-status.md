---
id: auction-status
title: Auction status
kind: term
status: draft
aliases: [closed, sold]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# Auction status
## Definition
Auction status is the lifecycle state of an auction. After the [close job](close-job.md) runs, an auction is `CLOSED`. From `CLOSED` it moves to [`SOLD`](auction-sold.md), [`SECOND_CHANCE`](second-chance.md) or [`UNSOLD`](auction-unsold.md). Moves come from the close job and the order events [`order.paid`](order-paid-event.md) and [`order.cancelled`](order-cancelled-event.md). `SOLD` is reached only on a matching `order.paid`, and the second chance is offered at most once.

## Example
- Winner pays: `CLOSED` → `SOLD`, and the owner and winner are told.
- Winner does not pay within 48 hours: the order becomes `CANCELLED(hold_expired)`, and the auction moves to `SECOND_CHANCE` for a runner-up at or above the [reserve](auction-reserve.md).
- Leader below reserve at close: `UNSOLD(reserve_not_met)`.

## Known gaps
- The spec does not name the states before `CLOSED`, for example while bidding is open.
- The spec does not say what happens if the second-chance order is also unpaid, beyond `UNSOLD` being a possible outcome.
- The spec does not say whether `UNSOLD` always returns the unit, except in the reserve-not-met case.

## Used by
<!-- used-by:start -->
- [auction-reserve](auction-reserve.md)
- [close-job](close-job.md)
<!-- used-by:end -->
