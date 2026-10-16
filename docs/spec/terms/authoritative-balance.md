---
id: authoritative-balance
title: Authoritative balance
kind: term
status: draft
aliases: [authoritative balances]
defined_for: S14-ledger-reconciliation
rules_hash: 1897ca754a79
---
# Authoritative balance
## Definition
An authoritative balance is read straight from the ledger's running balances, [the write model](write-model.md). It is not read from the [balance read model](read-model.md). It is exact at the moment of the read, including [uncommitted postings](ledger-posting.md) in the caller's transaction. The read model can lag behind and shows its age through [`asOf`](as-of.md). Code that makes money decisions inside a transaction should use authoritative balances. That last point is design intent (not stated in the spec).

## Example
`getBalances` returns authoritative balances. `GET /shops/:shopId/balance` serves `availableMinor` from the read model, so it may be slightly stale. It falls back to the running balance only when [the hot copy](hot-copy.md) and the durable copy both miss.

## Known gaps
- The spec does not say whether `listSellerBalances` returns authoritative balances or read-model balances.

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): R-15, B-11, B-16
- [S14](../capabilities/S14-ledger-reconciliation.md): R-23
- [balance-source](balance-source.md)
- [blocked-reason](blocked-reason.md)
- [durable-copy](durable-copy.md)
- [get-balances](get-balances.md)
- [hot-copy](hot-copy.md)
- [ledger-posting](ledger-posting.md)
- [list-seller-balances](list-seller-balances.md)
- [payout-minimum](payout-minimum.md)
- [read-model](read-model.md)
- [running-balance](running-balance.md)
- [write-model](write-model.md)
<!-- used-by:end -->
