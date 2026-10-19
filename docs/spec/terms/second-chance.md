---
id: second-chance
title: Second chance
kind: term
status: draft
aliases: [second_chance]
defined_for: J03-launch-day
rules_hash: 8ec36347a037
---
# Second chance
## Definition
`SECOND_CHANCE` is the auction state used when the winner does not pay their [settlement order](order-settlement.md) in time. The winner's order becomes [`CANCELLED(hold_expired)`](hold-expired.md), and the [runner-up](runner-up-offer.md), if their bid is at or above the reserve, gets one chance to buy. The second chance is offered at most once per auction. The auctions consumer drives the move on [`order.cancelled`](order-cancelled-event.md). If no second chance applies, the auction goes to `UNSOLD` instead.

## Example
The winner does not pay within 48 hours. Orders emits `order.cancelled` for the order, now `CANCELLED(hold_expired)`. The runner-up, who bid above the reserve, receives a chance to buy. Replaying `orders.events` does not create a second offer.

## Known gaps
- The spec does not say what happens if the runner-up also fails to pay. `UNSOLD` is implied by "at most once" but is not stated.
- The spec does not say what price the runner-up is offered, for example their own maximum bid.
- The spec does not say whether the runner-up gets an order and a notice in the same way as the original winner.

## Used by
<!-- used-by:start -->
- [auction-reserve](auction-reserve.md)
- [auction-unsold](auction-unsold.md)
- [auction-won-notice](auction-won-notice.md)
- [refused-leader](refused-leader.md)
<!-- used-by:end -->
