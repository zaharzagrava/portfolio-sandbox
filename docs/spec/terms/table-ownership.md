---
id: table-ownership
title: Table ownership
kind: term
status: draft
aliases: [owned tables]
defined_for: S13-payment-intents
rules_hash: e3500297bf8c
---
# Table ownership
## Definition
Table ownership means each domain may read and write only its own tables. Payments owns `Payment`, `PaymentHistory`, [`PayableOrder`](order-copy.md) (the order copy) and [`LedgerEntry`](ledger-posting.md), and payment code must not touch any other table. The payments domain learns about orders from [`orders.events`](orders-events-topic.md) and keeps its own copy, instead of reading the order system's tables. One likely reason is to keep domains independent so each can change its storage freely. That reasoning is design intent (not stated in the spec).

## Example
To check that an order is payable, [`checkPayable`](check-payable.md) reads `PayableOrder`, which is filled from [`order.reserved`](order-reserved-event.md), `order.paid` and `order.cancelled`. It never queries the orders domain's own order table (S13.R-25, proof S13 AS-64).

## Known gaps
- The spec does not say how this rule is enforced, for example through database permissions, a lint rule or a test. Only the scenario S13 AS-64 is cited.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-25
- [domain](domain.md)
- [entry-point](entry-point.md)
- [ledger-entry-table](ledger-entry-table.md)
<!-- used-by:end -->
