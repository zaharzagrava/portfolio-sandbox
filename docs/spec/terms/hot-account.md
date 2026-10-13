---
id: hot-account
title: Hot account
kind: term
status: draft
aliases: [hot accounts]
defined_for: S14-ledger-reconciliation
rules_hash: d7ff981cc1b3
---
# Hot account
## Definition
A hot account is a ledger account that almost every sale touches: `PLATFORM_FEES`, `PROVIDER_CLEARING` and `MARKETPLACE_CLEARING`. Each one is split into shards, and a [stable hash ↗](../sw-external-terms.md#stable-hash) of the journal's shard key picks the shard for a posting. This keeps postings from serializing on one balance row. A periodic `SWEEP` journal moves non-empty shards back into shard 0. Readers only see the logical balance.

## Example
Two captures arrive at the same moment. Their `SALE` journals hash to different shards of `PROVIDER_CLEARING`, for example shards 3 and 11 (illustrative). Neither waits for the other's [row lock ↗](../sw-external-terms.md#row-lock). Later, `ledger.sweep-hot-accounts` consolidates the shards into shard 0.

## Known gaps
- The spec does not say which field of a journal is its shard key.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): B-09
- [ledger-balance-shard](ledger-balance-shard.md)
- [ledger-system-accounts](ledger-system-accounts.md)
- [logical-balance](logical-balance.md)
- [payout-clearing](payout-clearing.md)
- [shard-key](shard-key.md)
- [shop-account](shop-account.md)
- [sweep-window](sweep-window.md)
<!-- used-by:end -->
