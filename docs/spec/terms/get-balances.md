---
id: get-balances
title: getBalances
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# getBalances
## Definition
`getBalances` is the [`LedgerService`](ledger-service.md) method that returns [authoritative balances](authoritative-balance.md) for a list of accounts. The number of accounts per call has a limit. It runs inside the [caller's transaction](active-transaction.md), so the balances it returns include postings that transaction has made but not yet committed. A [sharded account](ledger-balance-shard.md) is returned as one [logical account](logical-account.md), the sum of its shards. A shard is never shown on its own.

## Example
Inside the same transaction that just posted an [`AD_CHARGE`](journal-kind.md), ad billing reads that shop's balance and already sees the charge:
```ts
// illustrative call shape
await ledgerService.getBalances(['SHOP_<uuid>', 'PLATFORM_FEES']);
```

## Known gaps
- The spec does not give the method's signature or return shape. For example, it does not say whether each balance comes with its version or currency.
- The spec does not say what happens when a call asks for more accounts than the limit, or names an unknown account.
- Not confirmed in the code: whether `getBalances` locks the rows it reads, or only reads them.

## Used by
<!-- used-by:start -->
- [active-transaction](active-transaction.md)
- [authoritative-balance](authoritative-balance.md)
- [ledger-balance-shard](ledger-balance-shard.md)
- [logical-account](logical-account.md)
<!-- used-by:end -->
