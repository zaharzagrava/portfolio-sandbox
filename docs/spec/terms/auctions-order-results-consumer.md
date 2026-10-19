---
id: auctions-order-results-consumer
title: auctions-order-results consumer group
kind: term
status: draft
aliases: [auctions-order-results]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# auctions-order-results consumer group
## Definition
`auctions-order-results` is the [consumer group](consumer-group.md) through which the auctions domain reacts to the result of a winner order. It reads [`order.paid`](order-paid-event.md) and [`order.cancelled`](order-cancelled-event.md) from [`orders.events`](orders-events-topic.md). A matching `order.paid` moves the auction to `SOLD`. An unpaid winner order leads to [`SECOND_CHANCE`](second-chance.md) or `UNSOLD`, and the second chance is offered at most once. Like every consumer here, it must be idempotent, and while paused it must lose nothing.

## Example
A winner does not pay within 48 hours. The order becomes `CANCELLED(hold_expired)` and orders emits `order.cancelled`. `auctions-order-results` moves the auction to `SECOND_CHANCE`, and the runner-up at or above the reserve gets one chance. Replaying `orders.events` afterwards changes nothing.

## Known gaps
- The spec does not say how the consumer matches an `order.paid` or `order.cancelled` to an auction. Matching by order id is likely, but it is not confirmed.
- The spec does not say what the consumer does when an event arrives for an auction already in `SOLD` or `UNSOLD`.
- Not confirmed in the code: the consumer's class or file. The facts name only the group.

## Used by
<!-- used-by:start -->
- [payment-provider-chain](payment-provider-chain.md)
<!-- used-by:end -->
