---
id: journal-posted-event
title: JournalPosted event
kind: term
status: draft
aliases: [journal_posted]
defined_for: S14-ledger-reconciliation
rules_hash: 82b173e91b16
---
# JournalPosted event
## Definition
`JournalPosted` is the exported type of the [`ledger.journal_posted`](ledger-journal-posted-event.md) v2 event. The ledger emits exactly one of these events for every journal it posts. The event goes through the [outbox](inbox-table.md) in the same transaction as the entries and [running balances](running-balance.md), so it exists only if the journal committed. Each line in the event carries the account, [the shard](ledger-balance-shard.md), the amount, the resulting balance and the [balance version](balance-version.md). The [`BalanceProjector`](balance-projector.md) consumes it to update the [balance read model](read-model.md). It applies a line only when that line's balance version is newer than the version already stored.

## Example
Here is a [`SALE`](journal-kind.md) of 1000 [minor units](minor-units.md) with a 50 fee (values illustrative). It produces one `ledger.journal_posted` on [`ledger.events`](ledger-events-topic.md) with three lines:
- [`PROVIDER_CLEARING`](ledger-system-accounts.md), shard 7, amount -1000, resulting balance and version for that shard
- `MARKETPLACE_CLEARING`, shard 7, amount +950, resulting balance and version
- `PLATFORM_FEES`, shard 7, amount +50, resulting balance and version

## Known gaps
- The spec does not give the payload's exact field names, so check `JournalPosted` in `packages/backend/libs/domains/payments/application/events/ledger-events.ts` before you parse it.
- The spec does not say what happened to v1, or whether consumers must still accept it.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): B-01
- [balance-version](balance-version.md)
- [inbox-table](inbox-table.md)
- [ledger-balance-shard](ledger-balance-shard.md)
- [minor-units](minor-units.md)
- [read-model](read-model.md)
- [running-balance](running-balance.md)
<!-- used-by:end -->
