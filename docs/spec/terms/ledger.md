---
id: ledger
title: Ledger
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: 81f79ec1e0de
---
# Ledger
## Definition
The ledger is the [double-entry ↗](../sw-external-terms.md#double-entry-bookkeeping) record of every money movement on the platform, kept in the payments domain. Each movement is one [balanced, immutable journal](ledger-journal.md) that is posted once. Mistakes are fixed with a [reversing journal](reversing-journal.md), never by editing. The ledger keeps a [running balance](running-balance.md) for each account. It posts its own sales, refunds, settlements and [sweeps](shard-sweep.md). [Reconciliation](reconciliation.md) checks each [closed UTC day](closed-utc-day.md) against the payment provider's statement.

## Example
A captured payment of 10000 [minor units](minor-units.md) (illustrative), with the default fee of 50, becomes one [`SALE` journal](journal-kind.md):
```
[PROVIDER_CLEARING](ledger-system-accounts.md) -10000 | MARKETPLACE_CLEARING +9950 | PLATFORM_FEES +50
```
Later, [`order.paid`](order-paid-event.md) makes the [settlement consumer](settlement-consumer.md) move the 9950 from `MARKETPLACE_CLEARING` to the shops' `SHOP_<uuid>` accounts.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-08
- [adjusted-resolution](adjusted-resolution.md)
- [adjustment-journal](adjustment-journal.md)
- [closed-utc-day](closed-utc-day.md)
- [injected-clock](injected-clock.md)
- [journal-kind](journal-kind.md)
- [ledger-journal](ledger-journal.md)
- [minor-units](minor-units.md)
- [payment-capture](payment-capture.md)
- [platform-fee](platform-fee.md)
- [rebuildable-read-model](rebuildable-read-model.md)
- [reconciliation-issue-auto-resolve](reconciliation-issue-auto-resolve.md)
- [reconciliation-resolution](reconciliation-resolution.md)
- [reconciliation](reconciliation.md)
- [reversing-journal](reversing-journal.md)
- [running-balance](running-balance.md)
- [settlement-consumer](settlement-consumer.md)
- [shard-sweep](shard-sweep.md)
- [statement-day](statement-day.md)
<!-- used-by:end -->
