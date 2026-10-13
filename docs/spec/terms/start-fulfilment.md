---
id: start-fulfilment
title: startFulfilment
kind: term
status: draft
aliases: [start fulfilment]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# startFulfilment
## Definition
`startFulfilment` is the order command that moves a `PAID` order to `FULFILLING`. It is the first step of fulfilment, before `ship` and `deliver`. It runs only through `OrderFulfilmentService.apply`, which emits `order.fulfilment_changed`. Like every order move, it is a conditional change: it adds one history row and raises `version` by one.

## Example
For a `PAID` order, `startFulfilment`, then `ship {trackingCode}`, then `deliver` move it to `FULFILLING`, then `SHIPPED`, then `DELIVERED`. A full `charge.refunded` can still refund the order while it is `FULFILLING`.

## Known gaps
- The spec does not say who triggers this command (seller, staff or a job), and it lists no HTTP endpoint for it.
- The spec does not say which error a caller gets when the order is not `PAID`. `invalid_transition` is likely, but the facts do not confirm it.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
