---
id: order-status-history
title: Order status history
kind: term
status: draft
aliases: [history row]
defined_for: S10-cart-checkout
rules_hash: a1cbbd639284
---
# Order status history
## Definition
Order status history is the record of every [status move](order-status.md) an order has made. Each successful move writes exactly one history row, together with the [conditional status change](durable-conditional-write.md) and the [version increase](order-version.md). Because a move only happens when a request to change the order succeeds, the history rows list every such request that took effect on the order. Design intent (not stated in the spec): it gives an audit trail for support staff and lets you rebuild how an order reached its current status.

## Example
A buyer checks out, the [signed webhook](verified-webhook-event.md) marks the order paid, and the seller starts fulfilment. The order now has one history row for each move: `reserve`, then `markPaid`, then `startFulfilment`. Its `version` went up by 1 at each step.

## Known gaps
- The spec does not say which columns a history row holds, for example the previous status, the command, the reason, the actor or a timestamp.
- The spec does not say whether the history is visible through `GET /orders/:orderId` or is only stored internally.
- The spec does not say whether a command that is refused, or a duplicate command that changes nothing, leaves any history row.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-33
- [durable-conditional-write](durable-conditional-write.md)
- [order-command](order-command.md)
- [order-status](order-status.md)
- [order-version](order-version.md)
- [payments-events-topic](payments-events-topic.md)
- [ship-order](ship-order.md)
- [verified-webhook-event](verified-webhook-event.md)
<!-- used-by:end -->
