---
id: reserved-until
title: reservedUntil
kind: term
status: draft
aliases: [reservation deadline]
defined_for: order-reservation
rules_hash: 5eef8487bc3e
---
# reservedUntil
## Definition
`reservedUntil` is the time when an order's [stock hold](all-or-nothing-reservation.md) ends. It is set when stock is reserved, at the fixed hold duration after reservation. If the order is still [`RESERVED`](reservation-status.md) and unpaid at that time, it is cancelled with [`hold_expired`](hold-expired.md). Before then, the buyer can pay and the order can become [`PAID`](order-status.md).

## Example
Stock is reserved at `2026-10-13T10:00:00Z` (illustrative), so `reservedUntil` is `2026-10-13T10:15:00Z`.

## Known gaps
- The spec does not say where `reservedUntil` is stored: on the order, on each reservation, or on each [shop order](orders-domain.md).
- The spec does not say whether the buyer sees `reservedUntil`, for example as a countdown on the "Awaiting payment" screen.
- The spec does not say whether a [pending-order recovery](pending-order-recovery.md) that repeats the stock operations also resets `reservedUntil`.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): B-05
- [all-or-nothing-reservation](all-or-nothing-reservation.md)
- [orders-domain](orders-domain.md)
- [payment-command](payment-command.md)
- [payment-processor](payment-processor.md)
- [pending-order-recovery](pending-order-recovery.md)
<!-- used-by:end -->
