---
id: runner-up-offer
title: Runner-up offer
kind: term
status: draft
aliases: [runner-up]
defined_for: J03-launch-day
rules_hash: 51b171ba4492
---
# Runner-up offer
## Definition
The runner-up offer is the second chance an auction gives when the winner does not pay. The winner's order is cancelled as [`CANCELLED(hold_expired)`](hold-expired.md). Orders emits [`order.cancelled`](order-cancelled-event.md), and the auctions consumer moves the auction to `SECOND_CHANCE`. Only a runner-up at or above the reserve qualifies. The auction gives this chance only once and never repeats it.

## Example
The winner of an auction leaves their order unpaid for 48 hours. The order becomes `CANCELLED(hold_expired)`. The auction enters `SECOND_CHANCE`, and the runner-up at or above the reserve gets the offer.

## Known gaps
- The spec does not say how the runner-up is told, or which notice type is used.
- The spec does not say how long the runner-up has to pay. It also does not say whether their order goes through the same J01 chain.
- The spec does not say whether the auction becomes `UNSOLD` when no runner-up is at or above the reserve.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
