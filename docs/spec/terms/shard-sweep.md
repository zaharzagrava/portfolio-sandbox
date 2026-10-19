---
id: shard-sweep
title: Shard sweep
kind: term
status: draft
aliases: [sweep journal]
defined_for: S14-ledger-reconciliation
rules_hash: 1e10efcd4bb4
---
# Shard sweep
## Definition
The [shard](ledger-balance-shard.md) sweep is the scheduled job `ledger.sweep-hot-accounts`. It moves the balances of non-empty shards into one designated shard of the same account. For each account in each [window](sweep-window.md), it posts one [balanced](balanced-journal.md), [deterministic ↗](../sw-external-terms.md#deterministic-build) `SWEEP` journal. Only the ledger can post `SWEEP` journals. The [logical account](logical-account.md)'s total does not change, because a sweep moves money only between shards of the same account. Design intent (not stated in the spec): the sweep keeps balances from staying scattered across many shards.

## Example
In one window, [`PLATFORM_FEES`](ledger-system-accounts.md) shard 3 holds +50 and shard 9 holds +100 (illustrative). The sweep posts one `SWEEP` journal with lines shard 3 −50, shard 9 −100 and shard 0 +150. The journal sums to zero.

## Known gaps
- The spec does not say how sweep windows are bounded, or what the sweep reference used for (kind, reference) uniqueness is.
- The spec does not say whether postings that arrive during a sweep are included in it or left for the next window.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): R-09
- [S14](../capabilities/S14-ledger-reconciliation.md): R-19
- [balanced-journal](balanced-journal.md)
- [ledger-balance-shard](ledger-balance-shard.md)
- [ledger-jobs](ledger-jobs.md)
- [ledger-journal-kinds](ledger-journal-kinds.md)
- [ledger](ledger.md)
- [logical-account](logical-account.md)
- [sweep-window](sweep-window.md)
<!-- used-by:end -->
