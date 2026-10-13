---
id: ledger-accounts
title: LEDGER_ACCOUNTS
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# LEDGER_ACCOUNTS
## Definition
`LEDGER_ACCOUNTS` is the exported constant that names the [ledger's fixed platform accounts](ledger-system-accounts.md). Other domains use it to refer to accounts without spelling out raw account ids. The accounts are [`PROVIDER_CLEARING`](ledger-system-accounts.md), [`MARKETPLACE_CLEARING`](ledger-system-accounts.md), `PLATFORM_FEES`, `PAYOUT_CLEARING` and `PAYOUTS_SENT`. Per-shop seller accounts (`SHOP_<uuid>`) are not fixed names, so they come from [`shopAccount`](shop-account.md) instead. The ledger refuses any other account id, and any id with a shard suffix, with [`account_unknown`](account-unknown.md).

## Example
A `SALE` journal for a payment touches three of these accounts:
`PROVIDER_CLEARING -1000`, `MARKETPLACE_CLEARING +950`, `PLATFORM_FEES +50`. These amounts are illustrative and assume the default 50 minor-unit fee.

## Known gaps
- Not confirmed in the code: the shape of `LEDGER_ACCOUNTS` (object map, enum or array), or whether it includes the short name `CLEARING` for `MARKETPLACE_CLEARING`.
- The spec does not say whether callers should pass `CLEARING` or `MARKETPLACE_CLEARING` in journal lines, or whether both are accepted.

## Used by
<!-- used-by:start -->
- [ledger-system-accounts](ledger-system-accounts.md)
<!-- used-by:end -->
