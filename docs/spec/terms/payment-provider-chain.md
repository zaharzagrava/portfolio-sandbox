---
id: payment-provider-chain
title: J01 payment chain
kind: term
status: draft
aliases: [j01]
defined_for: J03-launch-day
rules_hash: fe747e810198
---
# J01 payment chain
## Definition
The J01 chain is the payment flow described by the J01 journey, which this [launch-day journey](launch-day-flow.md) reuses rather than redefines. An auction winner's order is paid through it, like any other order. The chain ends with the [orders domain](orders-domain.md) emitting [`order.paid`](order-paid-event.md) or [`order.cancelled`](order-cancelled-event.md). Launch day only depends on that final event, not on the steps inside the chain.

## Example
[`auctions.close`](auctions-close-job.md) closes an auction and creates one [winner order](winner-order.md). The winner pays that order through the J01 chain. Orders emits `order.paid`, and the [auctions consumer](auctions-order-results-consumer.md) moves the auction to `SOLD`.

## Known gaps
- The spec does not describe the steps of the J01 chain on this page. They belong to the J01 journey page.
- The spec does not say whether an auction winner order goes through the J01 chain differently from an ordinary checkout order.

## Used by
<!-- used-by:start -->
- [auction-sold](auction-sold.md)
<!-- used-by:end -->
