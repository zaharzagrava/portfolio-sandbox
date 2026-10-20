---
id: launch-day-flow
title: Launch-day flow
kind: term
status: draft
aliases: [flow, flows]
defined_for: J03-launch-day
rules_hash: 3cc43f8a0d5d
---
# Launch-day flow
## Definition
A launch-day flow is one run of a launch-day path from start to end. The paths are seat booking, a [flash-sale drop](drop.md), a live stream and an auction. Each flow has its own seats, units, comments or bids, and flow isolation keeps them apart. The [journey test](main-journeys.md) runs several flows at once to check the [hand-offs between domains](domain.md).

## Example
One buyer books seats for a launch event, buys a drop unit, then wins and pays an auction (J03.B-17). The [inbox](inbox-item.md) then holds each expected item exactly once, including [`booking.confirmed`](booking-confirmed-notification.md), [`order.confirmed`](order-confirmed-notification.md) and [`auction.won`](auction-won-notice.md).

## Known gaps
- The spec does not say how a flow is scoped, for example whether each flow uses its own shop, product, launch event or buyer accounts.
- The spec does not say how many flows the journey test runs at the same time.

## Used by
<!-- used-by:start -->
- [control-surface](control-surface.md)
- [flow-isolation](flow-isolation.md)
- [live-events-topic](live-events-topic.md)
- [live-stream](live-stream.md)
- [payment-provider-chain](payment-provider-chain.md)
- [stack](stack.md)
<!-- used-by:end -->
