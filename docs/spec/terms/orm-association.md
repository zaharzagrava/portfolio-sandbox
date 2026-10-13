---
id: orm-association
title: ORM association
kind: term
status: draft
aliases: [associations]
defined_for: S14-ledger-reconciliation
rules_hash: c7d5d0bf48f7
---
# ORM association
## Definition
An ORM association is a declared relationship between two registered model classes. It lets code load or join related rows through the ORM, and it usually comes with a [foreign key ↗](../sw-external-terms.md#foreign-key). The payments capability does not add an association or a foreign key from its models to a table owned by another domain. Data from other domains reaches payments through [events](event-payload.md) or through that domain's [in-process port](in-process-port.md). Design intent (not stated in the spec): with no association, other domains can change their schemas without breaking the ledger.

## Example
A [`SETTLEMENT` journal](settlement-journal.md) credits each shop its share, using the [`subtotalMinor`](shop-subtotal.md) values carried in the [`order.paid` payload](order-paid-event.md). The ledger does not follow an association from its own models to an orders model. The shop appears only as the id inside a [`SHOP_<uuid>` account](ledger-account.md).

## Known gaps
- The spec does not say whether payments uses associations between its own tables, such as [journal headers](ledger-journal.md) and their entries.
- Not confirmed in the code: whether a lint rule or a test enforces the no-cross-domain-association rule, or whether only code review checks it.

## Used by
<!-- used-by:start -->
- [event-payload](event-payload.md)
- [in-process-port](in-process-port.md)
- [ledger-account](ledger-account.md)
- [ledger-journal](ledger-journal.md)
- [model-registration](model-registration.md)
- [order-paid-event](order-paid-event.md)
- [settlement-journal](settlement-journal.md)
<!-- used-by:end -->
