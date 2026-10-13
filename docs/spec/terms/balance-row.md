---
id: balance-row
title: Balance row
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: 8fc34e127e4f
---
# Balance row
## Definition
A balance row stores the [running balance](running-balance.md) and a version for one (account, shard, currency). A [posting](ledger-posting.md) updates it with an [atomic increment ↗](../sw-external-terms.md#atomic-increment) inside the posting's transaction. No balance is ever computed by summing entries. A posting locks every balance row it touches in ascending (account, shard) order, whatever the line order. Waits on these locks are bounded, and a posting that runs out of time fails with the [retryable](retryable.md) [`ledger_busy`](ledger-busy.md). Design intent (not stated in the spec): the fixed lock order stops two postings from [deadlocking ↗](../sw-external-terms.md#deadlock).

## Example
A `PAYOUT` that debits `SHOP_<uuid>` locks that shop's balance row, checks that the balance stays at zero or above, and then increments it. If the balance would go below zero, the posting fails with `insufficient_balance`. If it would go outside the [safe-integer range ↗](../sw-external-terms.md#safe-integer-range), it fails with [`balance_overflow`](balance-overflow.md). The new balance and version go into the [`ledger.journal_posted` event](ledger-journal-posted-event.md).

## Known gaps
- Not confirmed in the code: how account ids are compared for "ascending" order, for example by full id or by short name such as `CLEARING`.
- The spec does not say what shard value a non-sharded account's balance row carries.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-20
- [aggregate-rows](aggregate-rows.md)
- [compare-rows](compare-rows.md)
- [ledger-balance-shard](ledger-balance-shard.md)
- [ledger-busy](ledger-busy.md)
- [ledger-journal-posted-event](ledger-journal-posted-event.md)
- [ledger-posting](ledger-posting.md)
- [retryable](retryable.md)
- [running-balance](running-balance.md)
<!-- used-by:end -->
