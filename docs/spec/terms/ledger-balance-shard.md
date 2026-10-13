---
id: ledger-balance-shard
title: Ledger balance shard
kind: term
status: draft
aliases: [shard, shards]
defined_for: S14-ledger-reconciliation
rules_hash: 635174223e47
---
# Ledger balance shard
## Definition
A ledger balance shard is one slice of a [hot ledger account](hot-account.md). Only `PLATFORM_FEES`, `PROVIDER_CLEARING` and `MARKETPLACE_CLEARING` are split into shards. Each has its own [balance row](balance-row.md), so concurrent postings update different rows and do not queue behind one lock. [A stable hash ↗](../sw-external-terms.md#stable-hash) of the journal's [shard key](shard-key.md) picks which shard a posting goes to. Reads and balances never show a shard. They show only the [logical account](logical-account.md), which is the sum of its shards.

## Example
A `SALE` journal whose shard key hashes to shard 17 (illustrative) writes its `PLATFORM_FEES +50` line to shard 17 of `PLATFORM_FEES`. A concurrent sale that hashes to shard 4 (illustrative) updates a different row and does not wait. The `ledger.journal_posted` v2 event reports the shard of each line.

## Known gaps
- The spec does not say what happens to existing shard balances when the shard-count setting is changed.
- The spec does not say which shard holds the single balance row of a non-sharded account, such as `SHOP_<uuid>`.
- Not confirmed in the code: whether all hot-account lines of one journal always land on the same shard index.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-18
- [account-unknown](account-unknown.md)
- [balance-projector](balance-projector.md)
- [balance-row](balance-row.md)
- [clearing-credit](clearing-credit.md)
- [compare-rows](compare-rows.md)
- [durable-copy](durable-copy.md)
- [get-balances](get-balances.md)
- [hot-account](hot-account.md)
- [journal-posted-event](journal-posted-event.md)
- [ledger-account](ledger-account.md)
- [ledger-system-accounts](ledger-system-accounts.md)
- [logical-account](logical-account.md)
- [logical-balance](logical-balance.md)
- [parse-account-id](parse-account-id.md)
- [shard-key](shard-key.md)
- [shard-sweep](shard-sweep.md)
- [shop-account](shop-account.md)
- [sweep-window](sweep-window.md)
<!-- used-by:end -->
