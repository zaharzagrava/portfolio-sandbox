---
id: durable-copy
title: Durable copy
kind: term
status: draft
aliases: [durable]
defined_for: S14-ledger-reconciliation
rules_hash: 2d836e0412db
---
# Durable copy
## Definition
The durable copy is the stored layer of the [balance read model](read-model.md). It survives restarts, and its entries don't expire. [The balance projector](balance-projector.md) writes it from [`ledger.journal_posted`](ledger-journal-posted-event.md) events, using the [balance-version check](balance-version.md). A read uses it when the hot copy has no usable entry. If the durable copy also has nothing, the read uses the [authoritative running balance](authoritative-balance.md).

## Example
The hot copy entry for a shop has expired. `GET /shops/:shopId/balance` then answers from the durable copy row for that shop's account. If that row doesn't exist yet, the answer comes from the running balance.

## Known gaps
- The spec does not say which table holds the durable copy, or whether one row covers the whole [logical account](logical-account.md) or one [shard](ledger-balance-shard.md).

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-26
- [authoritative-balance](authoritative-balance.md)
- [balance-projector](balance-projector.md)
- [balance-source](balance-source.md)
- [balance-version](balance-version.md)
- [get-shop-balance](get-shop-balance.md)
- [hot-copy](hot-copy.md)
- [ledger-backfill-balances-job](ledger-backfill-balances-job.md)
- [ledger-balance-shard](ledger-balance-shard.md)
- [logical-account](logical-account.md)
- [read-model](read-model.md)
- [rebuildable-read-model](rebuildable-read-model.md)
<!-- used-by:end -->
