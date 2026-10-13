---
id: ledger-journal-posted-event
title: ledger.journal_posted event
kind: term
status: draft
aliases: [ledger.journal_posted]
defined_for: S14-ledger-reconciliation
rules_hash: 47834807c834
---
# ledger.journal_posted event
## Definition
`ledger.journal_posted` is the event the ledger publishes once for every journal it posts. The current version is v2, and it goes to topic [`ledger.events`](ledger-events-topic.md). It is written to the [outbox](inbox-table.md) in the same transaction as the journal's entries and running balances. So the event exists if and only if the journal committed. For each line it carries the account, shard, amount, resulting balance and balance version. The [`BalanceProjector`](balance-projector.md) ([consumer group](consumer-group.md) `ledger-balances`) reads it to keep the [balance read model](read-model.md) up to date.

## Example
A `SALE` journal emits one event with three lines. The fee line might look like this (field names and values are illustrative):
```json
{ "account": "PLATFORM_FEES", "shard": 7, "amountMinor": 50,
  "balanceMinor": 125050, "balanceVersion": 2501 }
```

## Known gaps
- The spec does not list the exact payload field names. It also does not say whether the event carries the journal's kind, reference or `postedAt`.
- The spec does not say what changed from v1, or whether v1 is still published or accepted.
- The spec does not give the event key (partitioning key), so ordering between events for the same account is not guaranteed by anything stated.

## Used by
<!-- used-by:start -->
- [balance-row](balance-row.md)
- [balance-version](balance-version.md)
- [consumer-group](consumer-group.md)
- [inbox-table](inbox-table.md)
- [ledger-events-topic](ledger-events-topic.md)
- [order-tolerant](order-tolerant.md)
- [read-model](read-model.md)
- [rebuildable-read-model](rebuildable-read-model.md)
<!-- used-by:end -->
