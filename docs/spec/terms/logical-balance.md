---
id: logical-balance
title: Logical balance
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: ef297a63eaab
---
# Logical balance
## Definition
A logical balance is the balance of a whole [ledger account](ledger-account.md) as readers see it. For a [sharded hot account](hot-account.md), it is the sum of the [running balances](running-balance.md) of all its [shards](ledger-balance-shard.md). Reads always show the logical account and never show a single shard. [Postings](ledger-posting.md) spread across shards, but the logical balance stays exact.

## Example
`PLATFORM_FEES` is split into shards. After many [`SALE` journals](journal-kind.md), shards hold illustrative values such as shard 0 = 1,200, shard 7 = 50 and shard 19 = 100. [`getBalances`](get-balances.md) reports one `PLATFORM_FEES` balance of 1,350.

## Known gaps
- The spec does not say whether a logical balance read sums the shards in the [caller's transaction](active-transaction.md) or reads them at different moments.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): B-09
- [active-transaction](active-transaction.md)
- [hot-account](hot-account.md)
- [journal-kind](journal-kind.md)
- [ledger-account](ledger-account.md)
- [ledger-balance-shard](ledger-balance-shard.md)
- [ledger-posting](ledger-posting.md)
- [running-balance](running-balance.md)
<!-- used-by:end -->
