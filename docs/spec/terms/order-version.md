---
id: order-version
title: Order version
kind: term
status: draft
aliases: [version]
defined_for: S10-cart-checkout
rules_hash: a6ce1f11a5dc
---
# Order version
## Definition
The order version is a counter on each order. Every successful [status move](order-status.md) raises it by exactly 1. A move is a [conditional change](guarded-update.md), so it succeeds only if the order still has the version the command read. Two [concurrent moves](optimistic-concurrency.md) on the same order therefore cannot both succeed. This is how the [webhook](verified-webhook-event.md), the [payments consumer](event-consumer.md) and the [expiry jobs](hold-expired.md) can all act on one order without overwriting each other.

## Example
An order in [`RESERVED`](order-status.md) has `version` 2 (illustrative value). The webhook's [`markPaid`](order-command.md) and the expiry job's `cancel` both read version 2. One wins and moves the order to version 3. The other's conditional change matches no row, so it has no effect.

## Known gaps
- The spec does not say whether `version` appears in API responses or in the published `order.*` events.
- The spec does not say what the losing side of a concurrent move does next: retry, give up silently, or return an error to the caller.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-20
- [event-consumer](event-consumer.md)
- [get-order-by-id](get-order-by-id.md)
- [guarded-update](guarded-update.md)
- [hold-expired](hold-expired.md)
- [optimistic-concurrency](optimistic-concurrency.md)
- [order-command](order-command.md)
- [order-status-history](order-status-history.md)
- [order-status](order-status.md)
- [ship-order](ship-order.md)
- [verified-webhook-event](verified-webhook-event.md)
<!-- used-by:end -->
