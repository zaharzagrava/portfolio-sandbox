---
id: read-model
title: Read model
kind: term
status: draft
aliases: [read-model]
defined_for: S53-events-projections
rules_hash: 946da594fc9b
---
# Read model
## Definition
A read model is a query-optimised copy of data that a [projection consumer](event-consumer.md) builds from events. It is not the [source of truth](source-of-truth.md), and it can be rebuilt from the [event log](event-backbone.md) at any time. Because it is updated asynchronously, it can lag behind the [write model](write-model.md). The [read-your-writes helper](read-your-writes.md) checks the read model's checkpoint against [`minVersion`](min-version.md) to decide whether the read model is fresh enough to answer from.

## Example
A projection has applied events up to version 7 for an aggregate. A client calls the read route with `minVersion=7`. The route answers `200` from the read model:
```
X-Read-Source: read-model

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-40
- [S14](../capabilities/S14-ledger-reconciliation.md): R-25, R-42
- [S53](../capabilities/S53-events-projections.md): B-15
- [as-of](as-of.md)
- [authoritative-balance](authoritative-balance.md)
- [available-minor](available-minor.md)
- [balance-projector](balance-projector.md)
- [balance-version](balance-version.md)
- [durable-copy](durable-copy.md)
- [event-backbone](event-backbone.md)
- [event-consumer](event-consumer.md)
- [event-sink](event-sink.md)
- [get-shop-balance](get-shop-balance.md)
- [hot-copy](hot-copy.md)
- [journal-posted-event](journal-posted-event.md)
- [ledger-backfill-balances-job](ledger-backfill-balances-job.md)
- [ledger-events-topic](ledger-events-topic.md)
- [ledger-journal-posted-event](ledger-journal-posted-event.md)
- [ledger-lag-metric](ledger-lag-metric.md)
- [ledger-projector-module](ledger-projector-module.md)
- [list-seller-balances](list-seller-balances.md)
- [order-tolerant](order-tolerant.md)
- [read-your-writes](read-your-writes.md)
- [rebuildable-read-model](rebuildable-read-model.md)
- [running-balance](running-balance.md)
- [shop-search-freshness](shop-search-freshness.md)
- [source-of-truth](source-of-truth.md)
- [write-model](write-model.md)
<!-- used-by:end -->
