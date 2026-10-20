---
id: winner-order
title: Winner order
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: 44cc60f9c8ae
---
# Winner order
## Definition
The winner order is the settlement order created for the winning bidder when an auction closes. Closing creates exactly one, even under [duplicate triggers](duplicate-triggers.md). The winner pays it through the J01 chain. Orders then emits [`order.paid`](order-paid-event.md) or [`order.cancelled`](order-cancelled-event.md), and the auctions consumer moves the auction on. A paid winner order makes the auction `SOLD`, while an unpaid one leads to [`SECOND_CHANCE`](second-chance.md) or [`UNSOLD`](auction-unsold.md).

## Example
The winner does not pay within 48 hours. The order becomes `CANCELLED(hold_expired)`, and the runner-up at or above the reserve gets one chance (J03 AS-34). The consumer group `auctions-order-results` reacts to the order event.

## Known gaps
- The spec does not say how closing creates the order, for example a command to orders or a direct call.
- The spec does not say whether the order is created in the same transaction as the close.
- The spec does not say how a matching `order.paid` is recognised, for example by `orderId`.

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): R-10
- [auction-unsold](auction-unsold.md)
- [auction-won-event](auction-won-event.md)
- [auctions-close-job](auctions-close-job.md)
- [conditional-transition](conditional-transition.md)
- [duplicate-triggers](duplicate-triggers.md)
- [payment-provider-chain](payment-provider-chain.md)
- [refused-leader](refused-leader.md)
<!-- used-by:end -->
