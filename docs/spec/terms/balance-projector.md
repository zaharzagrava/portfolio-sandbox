---
id: balance-projector
title: BalanceProjector
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: 1c2d8e0e1783
---
# BalanceProjector
## Definition
`BalanceProjector` is the [event consumer](event-consumer.md) that keeps the [balance read model](read-model.md) up to date. It reads [`ledger.journal_posted`](ledger-journal-posted-event.md) v2 events from the [`ledger.events` topic](ledger-events-topic.md) as [consumer group `ledger-balances`](consumer-group.md). For each line it stores the account's resulting balance, but only when the line's [balance version](balance-version.md) is newer than the stored one. This makes it [idempotent ↗](../sw-external-terms.md#idempotency) and order-tolerant, and the read model stays rebuildable. Invalid events go to the [dead-letter topic](dead-letter-topic.md) and change nothing.

## Example
Two events for [`PLATFORM_FEES`](ledger-system-accounts.md) [shard 7](ledger-balance-shard.md) arrive out of order. The values are illustrative:
```
event A: balanceVersion 2501, balance 125050  -> stored (newer than 2500)
event B: balanceVersion 2500, balance 125000  -> skipped (older than stored 2501)
```

## Known gaps
- The spec does not say whether the projector writes the hot copy, the durable copy or both. It also does not say how the hot copy's expiry is set.
- The spec does not say how a rebuild runs. Not confirmed in the code: whether the [`ledger.backfill-balances` job](ledger-backfill-balances-job.md) is the rebuild path.
- The spec does not say how the [lag metric](ledger-lag-metric.md) is measured, or what it is named.

## Used by
<!-- used-by:start -->
- [as-of](as-of.md)
- [balance-version](balance-version.md)
- [consumer-group](consumer-group.md)
- [dead-letter-topic](dead-letter-topic.md)
- [durable-copy](durable-copy.md)
- [event-consumer](event-consumer.md)
- [ledger-backfill-balances-job](ledger-backfill-balances-job.md)
- [ledger-balance-shard](ledger-balance-shard.md)
- [ledger-events-topic](ledger-events-topic.md)
- [ledger-lag-metric](ledger-lag-metric.md)
- [order-tolerant](order-tolerant.md)
- [read-model](read-model.md)
- [rebuildable-read-model](rebuildable-read-model.md)
<!-- used-by:end -->
