---
id: order-fulfilment-service
title: OrderFulfilmentService
kind: term
status: draft
aliases: [orderfulfilmentservice.apply]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# OrderFulfilmentService
## Definition
`OrderFulfilmentService` is the [application service ↗](../sw-external-terms.md#application-service) that owns fulfilment moves. Its `apply` method is the only allowed way to run [`startFulfilment`](start-fulfilment.md), [`ship`](ship-order.md) or [`deliver`](deliver-order.md) on an order. Every move it applies publishes an [`order.fulfilment_changed`](order-fulfilment-changed-event.md) event. Design intent (not stated in the spec): with a single entry point, no fulfilment change can skip the event or the status rules.

## Example
A caller wants to mark a `FULFILLING` order as shipped. It calls `OrderFulfilmentService.apply` with the `ship` command; it does not update the order row directly. The order moves to the next status, its `version` goes up by 1, and `order.fulfilment_changed` is published.

Code: `packages/backend/libs/domains/orders/application/order-fulfilment.service.ts#OrderFulfilmentService`

## Known gaps
- Not confirmed in the code: the parameters of `apply` and what it returns.
- The spec does not say who calls `apply` or what permission check they must pass.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
