---
id: ledger-system-accounts
title: Ledger system accounts
kind: term
status: draft
aliases: [marketplace_clearing, platform_fees, provider_clearing]
defined_for: S14-ledger-reconciliation
rules_hash: a4eea25cc229
---
# Ledger system accounts
## Definition
The ledger system accounts are the platform's own accounts, as opposed to the [`SHOP_<uuid>`](ledger-account.md) seller accounts. They are `PROVIDER_CLEARING`, `MARKETPLACE_CLEARING` (short name `CLEARING`), `PLATFORM_FEES`, `PAYOUT_CLEARING` and `PAYOUTS_SENT`. The ledger accepts only these names and `SHOP_<uuid>`. Any other id, or an id with a shard suffix, is refused with [`account_unknown`](account-unknown.md). On a sale, `PROVIDER_CLEARING` takes the captured amount, `MARKETPLACE_CLEARING` holds what will go to shops, and `PLATFORM_FEES` holds the platform's fee. The three [hot accounts](hot-account.md) are split into [shards](ledger-balance-shard.md), but reads always show one [logical account](logical-account.md). Lines on `PAYOUT_CLEARING` may never take its balance below zero.

## Example
A [`SALE` journal](ledger-journal.md) for a captured payment of 10000 [minor units](minor-units.md), with the [default fee](platform-fee.md) of 50 (amount illustrative):
```
PROVIDER_CLEARING     -10000
MARKETPLACE_CLEARING   +9950
PLATFORM_FEES             +50
```

## Known gaps
- The spec does not say what `PAYOUT_CLEARING` and `PAYOUTS_SENT` hold, or which journal kinds post to them.
- The spec does not say which sign means debit and which means credit. [The settlement rule](settlement-journal.md) calls the `+(A-F)` line a "clearing credit", which suggests positive means credit.

## Used by
<!-- used-by:start -->
- [balanced-journal](balanced-journal.md)
- [hot-account](hot-account.md)
- [ledger-accounts](ledger-accounts.md)
- [ledger-balance-shard](ledger-balance-shard.md)
- [ledger-journal](ledger-journal.md)
- [logical-account](logical-account.md)
- [minor-units](minor-units.md)
- [parse-account-id](parse-account-id.md)
- [payer-id](payer-id.md)
- [payout-clearing](payout-clearing.md)
- [platform-fee](platform-fee.md)
- [settlement-journal](settlement-journal.md)
<!-- used-by:end -->
