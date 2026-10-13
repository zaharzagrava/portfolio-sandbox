---
id: ledger-account
title: Ledger account
kind: term
status: draft
aliases: [account, accounts]
defined_for: S14-ledger-reconciliation
rules_hash: 5269d098bf06
---
# Ledger account
## Definition
A ledger account is a named bucket of money that journal lines debit or credit. The set is fixed: [`PROVIDER_CLEARING`](ledger-system-accounts.md), [`MARKETPLACE_CLEARING`](ledger-system-accounts.md) (short name `CLEARING`), [`PLATFORM_FEES`](ledger-system-accounts.md), [`PAYOUT_CLEARING`](ledger-system-accounts.md), [`PAYOUTS_SENT`](ledger-system-accounts.md), and one `SHOP_<uuid>` per shop. A `SHOP_<uuid>` account is the "seller account". Any other id is refused with [`account_unknown`](account-unknown.md). The buyer is never an account. Each account has a [running balance](running-balance.md) and version per [shard](ledger-balance-shard.md) and currency. Busy accounts are split into shards, but reads always show them as one account.

## Example
`SHOP_<uuid>` is credited its share by a [`SETTLEMENT`](settlement-journal.md). A [`PAYOUT`](journal-kind.md) that would take it below zero fails with [`insufficient_balance`](insufficient-balance.md). A [`REFUND`](ledger-journal-kinds.md) that [claws back](clawback.md) a [settled share](settled-sale.md) may take it negative.

## Known gaps
- The spec does not say whether `SHOP_<uuid>` must belong to an existing shop, or only needs to be a well-formed id.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-09, R-10, R-12, B-06, B-07
- [clawback](clawback.md)
- [guarded-account](guarded-account.md)
- [keyset-pagination](keyset-pagination.md)
- [ledger-balance-shard](ledger-balance-shard.md)
- [ledger-journal](ledger-journal.md)
- [logical-balance](logical-balance.md)
- [orm-association](orm-association.md)
- [parse-account-id](parse-account-id.md)
- [payer-id](payer-id.md)
- [running-balance](running-balance.md)
- [settled-sale](settled-sale.md)
<!-- used-by:end -->
