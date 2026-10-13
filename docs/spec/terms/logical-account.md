---
id: logical-account
title: Logical account
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: 3194c3ec0d8c
---
# Logical account
## Definition
A logical account is a ledger account as callers and readers see it, such as `PLATFORM_FEES`. Its balance is the sum of the balances of all its shards. Callers address only the logical account: an account id with a shard suffix is refused with `account_unknown`. Reads never return the individual shards.

## Example
`[getBalances](get-balances.md)` asked for `PLATFORM_FEES` returns one balance. This is the sum across all shards, for example 32 shards by default. It never returns 32 separate figures.

## Known gaps
- Not confirmed in the code: whether the sum over shards is taken inside the [caller's transaction](active-transaction.md), giving one [consistent snapshot ↗](../sw-external-terms.md#serializable-isolation) of all shards.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-18
- [account-unknown](account-unknown.md)
- [active-transaction](active-transaction.md)
- [durable-copy](durable-copy.md)
- [get-balances](get-balances.md)
- [ledger-balance-shard](ledger-balance-shard.md)
- [ledger-system-accounts](ledger-system-accounts.md)
- [parse-account-id](parse-account-id.md)
- [running-balance](running-balance.md)
- [shard-sweep](shard-sweep.md)
<!-- used-by:end -->
