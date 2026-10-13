---
id: running-balance
title: Running balance
kind: term
status: draft
aliases: [running balances]
defined_for: S14-ledger-reconciliation
rules_hash: 3401fc2e240b
---
# Running balance
## Definition
A running balance is the stored total of one [(account, shard, currency)](logical-account.md), kept together with a [version](balance-version.md). Each [posting](ledger-posting.md) updates it with an [atomic increment ↗](../sw-external-terms.md#atomic-increment) inside the posting's own transaction. Balances are never computed by summing entries. `[getBalances](get-balances.md)` reads these values as the [authoritative balance](authoritative-balance.md). Each [`ledger.journal_posted`](ledger-journal-posted-event.md) event line carries the resulting balance and its version, and the [read model](read-model.md) uses that version to apply only newer values.

## Example
`PLATFORM_FEES`, shard 7, EUR has a balance of 12350 at version 41. A `SALE` with a fee of 50 changes it to 12400 at version 42. (All values are illustrative.)

## Known gaps
- The spec does not say how the version advances, for example by exactly one per posting.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-04, R-22, R-42
- [aggregate-rows](aggregate-rows.md)
- [as-of](as-of.md)
- [authoritative-balance](authoritative-balance.md)
- [balance-overflow](balance-overflow.md)
- [balance-row](balance-row.md)
- [balance-version](balance-version.md)
- [get-shop-balance](get-shop-balance.md)
- [guarded-account](guarded-account.md)
- [hot-copy](hot-copy.md)
- [insufficient-balance](insufficient-balance.md)
- [journal-posted-event](journal-posted-event.md)
- [journal-unbalanced](journal-unbalanced.md)
- [ledger-account](ledger-account.md)
- [ledger-backfill-balances-job](ledger-backfill-balances-job.md)
- [ledger-posting](ledger-posting.md)
- [ledger-store](ledger-store.md)
- [ledger-verify-invariants](ledger-verify-invariants.md)
- [ledger](ledger.md)
- [logical-account](logical-account.md)
- [logical-balance](logical-balance.md)
- [no-negative-guard](no-negative-guard.md)
- [payout-clearing](payout-clearing.md)
- [post-journal](post-journal.md)
- [read-model](read-model.md)
- [rebuildable-read-model](rebuildable-read-model.md)
<!-- used-by:end -->
