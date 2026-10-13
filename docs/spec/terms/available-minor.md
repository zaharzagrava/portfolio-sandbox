---
id: available-minor
title: availableMinor
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# availableMinor
## Definition
`availableMinor` is the field in the [`GET /shops/:shopId/balance`](get-shop-balance.md) response that holds the shop's available balance. It is in [minor units](minor-units.md). Only a shop member with the [`payouts.read`](permission.md) permission can read it. The value can be negative, because [ledger postings](ledger-posting.md) other than [`PAYOUT`](journal-kind.md) are allowed to take a seller account below zero. The value comes from the [balance read model](read-model.md), so it can lag a little behind the ledger, and [`asOf`](as-of.md) shows how fresh it is.

## Example
A shop's order was settled and then refunded, so the refund took back more than the shop had left:
```json
{ "availableMinor": -1200 }
```
(the value is illustrative)

## Known gaps
- The spec does not say whether `availableMinor` is exactly the running balance of the shop's `SHOP_<uuid>` account, or whether something such as an in-progress payout is subtracted from it.
- The spec does not say which other fields come with it in the response, for example the currency or the exact place of `asOf`.

## Used by
<!-- used-by:start -->
- [ledger-posting](ledger-posting.md)
- [minor-units](minor-units.md)
- [read-model](read-model.md)
<!-- used-by:end -->
