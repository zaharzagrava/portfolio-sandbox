---
id: shard-key
title: Shard key
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: d2f60b3fdf2c
---
# Shard key
## Definition
The shard key is the value on a journal that decides which ledger balance shard its [hot-account](hot-account.md) lines go to. The ledger hashes it with a [stable hash ↗](../sw-external-terms.md#stable-hash), so the same key always maps to the same shard. Different keys spread postings across shards, so busy accounts do not [serialize ↗](../sw-external-terms.md#mutual-exclusion) the platform.

## Example
Two [`SALE`](journal-kind.md) journals for different payments have different shard keys. They hash to different shards of `PROVIDER_CLEARING`, for example shards 3 and 22 (illustrative), and post in parallel.

## Known gaps
- The spec does not say which field of the journal is the shard key, for example the journal id, the payment, or the reference.
- The spec does not name the hash function.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-18
- [compare-rows](compare-rows.md)
- [hot-account](hot-account.md)
- [ledger-balance-shard](ledger-balance-shard.md)
- [parse-account-id](parse-account-id.md)
<!-- used-by:end -->
