---
id: balanced-journal
title: Balanced journal
kind: term
status: draft
aliases: [balanced]
defined_for: S14-ledger-reconciliation
rules_hash: 27023d72d80b
---
# Balanced journal
## Definition
A balanced journal is a journal whose lines sum to exactly zero in a single currency. Every line must be a non-zero whole number of [minor units](minor-units.md). Line counts outside the allowed range are refused with a named reason, and nothing is written. The store also refuses an unbalanced journal [at commit ↗](../sw-external-terms.md#database-transaction), whatever code wrote it. This means a bug that skips validation still cannot record money that comes from nowhere.

## Example
A `SALE` for a capture of 10000 minor units (illustrative), with the [default fee](platform-fee.md) of 50:
```
[PROVIDER_CLEARING](ledger-system-accounts.md)     -10000
[MARKETPLACE_CLEARING](ledger-system-accounts.md)   +9950
[PLATFORM_FEES](ledger-system-accounts.md)            +50
                     sum = 0

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-19, R-39, R-42
- [adjustment-journal](adjustment-journal.md)
- [ledger-invariants](ledger-invariants.md)
- [ledger-journal](ledger-journal.md)
- [ledger-system-accounts](ledger-system-accounts.md)
- [minor-units](minor-units.md)
- [payout-journal](payout-journal.md)
- [platform-fee](platform-fee.md)
- [shard-sweep](shard-sweep.md)
<!-- used-by:end -->
