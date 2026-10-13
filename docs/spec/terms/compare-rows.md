---
id: compare-rows
title: compareRows
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# compareRows
## Definition
`compareRows` is a [pure function ↗](../sw-external-terms.md#pure-function) in the [payments domain layer](payments-domain-layer.md), in `lock-order.ts`. It decides the order in which a [posting](ledger-posting.md) locks the [balance rows](balance-row.md) it touches. The order is always ascending by (account, [shard](ledger-balance-shard.md)), however the journal's lines are ordered (S14.R-20). Because every posting takes its locks in the same order, two concurrent postings on the same accounts wait for each other instead of [deadlocking ↗](../sw-external-terms.md#deadlock). That reason is design intent (not stated in the spec). If a lock wait still runs past its bound, the posting fails with [`ledger_busy`](ledger-busy.md).

## Example
A `SALE` journal from `recordPaymentCaptured` has its lines in this order: `PROVIDER_CLEARING -A`, `MARKETPLACE_CLEARING +(A-F)`, `PLATFORM_FEES +F`. Each line falls on a shard chosen by the journal's [shard key](shard-key.md), for example shard 7 (illustrative). If account ids compare as plain strings (illustrative), the posting locks the rows in this order:
```
(MARKETPLACE_CLEARING, 7) → (PLATFORM_FEES, 7) → (PROVIDER_CLEARING, 7)
```

## Known gaps
- The spec does not say how account ids are compared: plain string order, or some other ranking of the system accounts and `SHOP_<uuid>` accounts.
- The spec does not say whether currency breaks ties. A balance row is keyed by (account, shard, currency), but the lock order only names (account, shard).
- Not confirmed in the code: whether `compareRows` is a comparator passed to a sort, or whether it also sets the order of the balance updates after the locks are taken.

## Used by
<!-- used-by:start -->
- [balance-row](balance-row.md)
- [ledger-balance-shard](ledger-balance-shard.md)
- [ledger-posting](ledger-posting.md)
- [payments-domain-layer](payments-domain-layer.md)
- [shard-key](shard-key.md)
<!-- used-by:end -->
