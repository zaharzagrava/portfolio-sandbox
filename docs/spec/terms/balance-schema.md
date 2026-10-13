---
id: balance-schema
title: balanceSchema
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# balanceSchema
## Definition
`balanceSchema` is the response shape of [`GET /shops/:shopId/balance`](get-shop-balance.md). It contains the shop's available balance as [`availableMinor`](available-minor.md), which may be negative. It also has a [`source`](balance-source.md) that tells you where the number came from. The rules say [staleness](as-of.md) is visible through [`asOf`](as-of.md), so the response likely carries an `asOf` time. The number is the same whatever the source.

## Example
```json
{ "availableMinor": 12500, "source": "read_model", "asOf": "2026-10-13T09:00:00Z" }
```
(illustrative values; the field list is partial)

## Known gaps
- The spec does not list every member of `balanceSchema`. For example, it does not say whether the response includes a currency.
- Not confirmed in the code: that `asOf` is a member of this schema. The rules only say staleness is visible through `asOf`.

## Used by
<!-- used-by:start -->
- [as-of](as-of.md)
<!-- used-by:end -->
