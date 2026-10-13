---
id: balance-version
title: Balance version
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: f75f30fe7da1
---
# Balance version
## Definition
The balance version is a counter the ledger keeps next to each running balance, per (account, shard, currency). It goes up in the same transaction as the balance itself, using an [atomic increment ↗](../sw-external-terms.md#atomic-increment), whenever a posting touches that row. Every line of a [`ledger.journal_posted` event](ledger-journal-posted-event.md) carries the version that line produced. The [read model](read-model.md) applies a line only when its version is newer than the one it has stored. This is what makes the [projector](search-projector.md) [idempotent ↗](../sw-external-terms.md#idempotency) and lets it accept events out of order.

## Example
The read model holds `PLATFORM_FEES` shard 7 at version 43. An event line for the same row arrives late with version 42, so `decideVersion` skips it. A later line with version 44 is applied. (The version numbers are illustrative.)

## Known gaps
- The spec does not say whether the version always goes up by exactly one per posting, or only increases strictly. That matters if you want to detect gaps.
- The spec does not give the field name of the version in the event payload or in the balance table.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-22, R-24
- [balance-projector](balance-projector.md)
- [durable-copy](durable-copy.md)
- [journal-posted-event](journal-posted-event.md)
- [ledger-events-topic](ledger-events-topic.md)
- [ledger-journal-posted-event](ledger-journal-posted-event.md)
- [order-tolerant](order-tolerant.md)
- [read-model](read-model.md)
- [running-balance](running-balance.md)
- [search-projector](search-projector.md)
<!-- used-by:end -->
