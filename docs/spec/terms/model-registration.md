---
id: model-registration
title: Model registration
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: 69e0180f36b0
---
# Model registration
## Definition
Model registration means declaring an [ORM model class ↗](../sw-external-terms.md#orm) for a database table, so that code can query that table through the ORM. In this system's payments capability, models are registered only for tables that payments owns. It never registers a model for another domain's table, and it adds no [association](orm-association.md) or [foreign key ↗](../sw-external-terms.md#foreign-key) to one either. Data from other domains arrives through events or their [in-process ports](in-process-port.md) instead. The design intent (not stated in the spec) is to keep other domains' schemas private, so they can change without breaking the ledger.

## Example
Settlement needs each shop's share of an order. It takes [`subtotalMinor`](shop-subtotal.md) from the [`order.paid` payload](order-paid-event.md), not from a model registered on an orders table (that table is illustrative).

## Known gaps
- Not confirmed in the code: whether a lint or test enforces this rule, or whether it is only a review check.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-45
- [in-process-port](in-process-port.md)
- [order-paid-event](order-paid-event.md)
- [orm-association](orm-association.md)
<!-- used-by:end -->
