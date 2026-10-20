---
id: attributed-order
title: Attributed order
kind: term
status: draft
aliases: [attributed]
defined_for: J05-engagement-loop
rules_hash: aec2e0539fdb
---
# Attributed order
## Definition
An attributed order is an order whose checkout accepted a `ref`, so a [link owner](link-owner.md) stands to be credited. Once it is paid, it yields a single [conversion](conversion.md) for that owner. Duplicate or late [`order.paid`](order-paid-event.md) events do not add more conversions. A [full refund reverses that conversion](conversion-reversal.md). Declined or cancelled attributed orders produce none.

## Example
F sends checkout five times with one [Idempotency-Key](idempotency-key.md) and B's code as `ref` → one order exists, attributed to B.
`order.paid` arrives twice → B still has exactly one conversion.

## Known gaps
- The spec does not say whether an order's attribution can change after checkout.
- The spec does not say how "late" an `order.paid` event may be and still be credited.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
