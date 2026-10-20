---
id: auction-sold
title: SOLD auction outcome
kind: term
status: draft
aliases: [sold]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# SOLD auction outcome
## Definition
`SOLD` is the successful end state of an auction. It is reached only when the winner's [settlement order](order-settlement.md) is paid. Payment goes through the [J01 chain](payment-provider-chain.md), orders emits [`order.paid`](order-paid-event.md), and the [`auctions-order-results`](auctions-order-results-consumer.md) consumer group reacts. A closed auction alone is not sold: it stays [`CLOSED`](auction-status.md) until a matching `order.paid` arrives. When the auction becomes `SOLD`, both the shop owner and the winner are notified.

## Example
After `auctions.close`, the auction is `CLOSED` and the winner has one order. The winner pays, and orders emits `order.paid` for that order. The auctions consumer moves the auction to `SOLD`, and the owner and the winner each get a notice.

## Known gaps
- The spec does not define what makes an `order.paid` "matching". Matching by order id is likely but not confirmed.
- The spec does not name the notification types sent to the owner and the winner on `SOLD`.

## Used by
<!-- used-by:start -->
- [order-settlement](order-settlement.md)
- [payment-provider-chain](payment-provider-chain.md)
<!-- used-by:end -->
