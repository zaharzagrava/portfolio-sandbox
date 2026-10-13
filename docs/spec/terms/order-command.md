---
id: order-command
title: Order command
kind: term
status: draft
aliases: [cancel, deliver, markpaid, order commands, reserve, ship, startfulfilment]
defined_for: S10-cart-checkout
rules_hash: d8bcc966c03d
---
# Order command
## Definition
An order command is one of the named operations that can change an order's status: `reserve`, [`markPaid`](paid-mark.md), `cancel`, [`startFulfilment`](start-fulfilment.md), `ship`, `deliver` and `refund`. Commands are the only way to change an order's status. Each command checks the current status, then makes one [conditional change](guarded-update.md), writes one [history row](order-status-history.md) and [raises the version](order-version.md). The decision logic is in the [order state module](order-status.md)'s `decide` function.

## Example
- `POST /orders/:orderId/cancel` on a `RESERVED` order runs `cancel`.
- A verified `payment_failed` event also runs `cancel` on a `RESERVED` order.
- A full `charge.refunded` event runs `refund` on a `PAID` or `FULFILLING` order.
- A late payment failure after `PAID` is ignored, so no command takes effect.

Code: `packages/backend/libs/domains/orders/domain/order-state.ts#decide`

## Known gaps
- The spec does not give the full table of which command is allowed from which of the 8 statuses. It also does not name every status.
- The spec does not say what a refused command returns to an HTTP caller, for example whether cancelling a `PAID` order gives `invalid_transition`.

## Used by
<!-- used-by:start -->
- [deliver-order](deliver-order.md)
- [fulfilment](fulfilment.md)
- [guarded-update](guarded-update.md)
- [order-status-history](order-status-history.md)
- [order-status](order-status.md)
- [order-version](order-version.md)
<!-- used-by:end -->
