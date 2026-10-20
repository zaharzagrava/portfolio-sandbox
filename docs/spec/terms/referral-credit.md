---
id: referral-credit
title: Referral credit
kind: term
status: draft
aliases: [credit]
defined_for: J05-engagement-loop
rules_hash: ccaa61002dfb
---
# Referral credit
## Definition
Referral credit is a [conversion](conversion.md) recorded for a [link owner](link-owner.md) when an [attributed order](attributed-order.md) is paid. The [`marketing-affiliate-conversions` consumer group](conversion-consumer.md) creates it from `order.paid` events on `orders.events`. A click alone never earns credit; the order must carry [`ref`](order-ref.md). A full refund reverses the conversion. A declined or cancelled order never creates one. The owner sees the conversion but never the buyer's identity.

## Example
F pays an order checked out with B's code → B has one conversion.
The order is later fully refunded → after the conversion consumer runs, B's conversion shows the reversal.

## Known gaps
- The spec does not say what a partial refund does to the conversion.
- The spec does not say what reward, if any, a conversion is worth to the owner.
- The spec does not say the fields of the `link.converted` event, except that they exclude the buyer's identity.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
