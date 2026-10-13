---
id: shop-account
title: shopAccount
kind: term
status: draft
aliases: [shopaccount(...)]
defined_for: S14-ledger-reconciliation
rules_hash: 4b16f7a47b31
---
# shopAccount
## Definition
`shopAccount` is a helper exported from the ledger's [public entry point](barrel-export.md), next to [`LedgerService`](ledger-service.md) and [`LEDGER_ACCOUNTS`](ledger-accounts.md). Other domains use it to name one shop's own ledger account when they build [journal lines](ledger-journal.md). In the ledger, a shop's account has the form `SHOP_<uuid>`. Unlike the [hot system accounts](hot-account.md), shop accounts are not split into [shards](ledger-balance-shard.md). A shop account must not go below zero on a [`PAYOUT` journal](journal-kind.md), but other journal kinds may take it negative.

## Example
A payouts module builds a `PAYOUT` journal for [`postJournal`](post-journal.md). The seller line uses `shopAccount(shopId)` as its account, and the other line uses [`PAYOUT_CLEARING`](ledger-system-accounts.md):
```
{ account: shopAccount("3f2a…"), amountMinor: -12000 }   // illustrative: SHOP_3f2a…
{ account: "PAYOUT_CLEARING",    amountMinor:  12000 }
```

## Known gaps
- Not confirmed in the code: what `shopAccount` takes and returns. The name and the `SHOP_<uuid>` account form suggest it turns a shop id into that account id.
- The spec does not say whether `shopAccount` checks that its input is a valid UUID, or whether that check happens only later in [`parseAccountId`](parse-account-id.md) ([`account_unknown`](account-unknown.md)).

## Used by
<!-- used-by:start -->
- [barrel-export](barrel-export.md)
- [hot-account](hot-account.md)
- [journal-kind](journal-kind.md)
- [ledger-balance-shard](ledger-balance-shard.md)
- [ledger-journal](ledger-journal.md)
- [parse-account-id](parse-account-id.md)
<!-- used-by:end -->
