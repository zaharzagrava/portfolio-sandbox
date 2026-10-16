---
id: ledger-lag-metric
title: Ledger lag metric
kind: term
status: draft
aliases: [lag metric]
defined_for: S14-ledger-reconciliation
rules_hash: 0149ac5b443b
---
# Ledger lag metric
## Definition
The ledger lag metric measures how far the [balance read model](read-model.md) trails the [ledger's postings](ledger-posting.md). Operators use it to see staleness for the whole system. `asOf` shows staleness for a single balance. A rising lag means the [projector](search-projector.md) ([consumer group](consumer-group.md) `ledger-balances`) is falling behind or stuck.

## Example
The `ledger-balances` projector stops consuming [`ledger.events`](ledger-events-topic.md). The lag metric climbs, and shop balance reads return older values whose `asOf` falls further behind. That tells an operator to look at the projector.

## Known gaps
- The spec does not give the metric's name, its unit, or whether it measures time or a number of events.
- The spec does not say whether any alert or threshold is attached to it.

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): B-16
- [S14](../capabilities/S14-ledger-reconciliation.md): R-26
- [as-of](as-of.md)
- [balance-projector](balance-projector.md)
- [consumer-group](consumer-group.md)
- [ledger-posting](ledger-posting.md)
- [read-model](read-model.md)
- [search-projector](search-projector.md)
<!-- used-by:end -->
