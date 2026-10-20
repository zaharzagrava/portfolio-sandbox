---
id: referral-conversion
title: Referral conversion
kind: term
status: draft
aliases: [conversions]
defined_for: J05-engagement-loop
rules_hash: dbb2990189c4
---
# Referral conversion
## Definition
A referral conversion credits a share-link owner when an order placed with their link's `ref` is paid. It is built from [`order.paid`](order-paid-event.md) in [`orders.events`](orders-events-topic.md) by the `marketing-affiliate-conversions` consumer group. Each attributed paid order yields exactly one conversion, even under duplicate or late `order.paid`. A full refund reverses it; declined or cancelled orders never create one. The owner never learns who bought.

## Example
B creates a share link; anonymous F follows it and checks out with `ref` set to the link's code, then pays. B has one conversion.
If B uses their own link, checkout answers `202` with `attribution: null` and B gets no conversion.

## Known gaps
- The spec does not say what amount or commission a conversion credits.
- The spec does not say what a partial refund does to a conversion; only a full refund is stated.
- The spec does not say the contents of the `link.converted` event beyond excluding buyer identity.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
