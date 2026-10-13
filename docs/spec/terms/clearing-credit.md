---
id: clearing-credit
title: Clearing credit
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: 14765a0c1123
---
# Clearing credit
## Definition
The clearing credit is the [`MARKETPLACE_CLEARING`](ledger-system-accounts.md) line that a `SALE` journal posts. Its amount is the captured amount minus the platform fee. It holds the sellers' money on the marketplace's side until the order is settled. The `SETTLEMENT` journal debits it and credits each shop its shop share. A refund of an unsettled sale reverses it. A refund of a settled sale also reverses every shop share.

## Example
Payment captured for 10000 minor units, with a fee of 50 (illustrative values):
```
SALE        PROVIDER_CLEARING -10000 | MARKETPLACE_CLEARING +9950 | PLATFORM_FEES +50
SETTLEMENT  MARKETPLACE_CLEARING -9950 | SHOP_<uuid> +... (shares summing to 9950)
```
The clearing credit here is the `+9950` line on `MARKETPLACE_CLEARING`.

## Known gaps
- The spec does not say which [shard](ledger-balance-shard.md) of `MARKETPLACE_CLEARING` the settlement debit hits. It also does not say whether that shard is the same one the sale credited.
- The spec does not say what happens to a clearing credit when no `order.paid` arrives for a captured payment. It only covers deferring when the sale is missing.
- Not confirmed in the code: "clearing credit" may only be a word used in the spec and not a named type or field.

## Used by
<!-- used-by:start -->
- [ledger-balance-shard](ledger-balance-shard.md)
- [settled-sale](settled-sale.md)
- [settlement-journal](settlement-journal.md)
- [shop-share](shop-share.md)
<!-- used-by:end -->
