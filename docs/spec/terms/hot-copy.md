---
id: hot-copy
title: Hot copy
kind: term
status: draft
aliases: [hot]
defined_for: S14-ledger-reconciliation
rules_hash: b3f1b0ed8705
---
# Hot copy
## Definition
The hot copy is the fast first layer of the [balance read model](read-model.md). Every entry in it has an expiry. A balance read tries the hot copy first. If the entry is missing or expired, the read falls back to the [durable copy](durable-copy.md) and then to the [running balance](running-balance.md). The hot copy exists so balance reads stay fast and don't load the [ledger tables](ledger-entry-table.md); that is design intent (not stated in the spec).

## Example
`GET /shops/:shopId/balance` for a [shop member](shop-member.md) with [`payouts.read`](permission.md):
1. The hot copy has an unexpired entry, so the answer comes from it.
2. The entry has expired, so the read tries the durable copy.

## Known gaps
- The spec does not say which store holds the hot copy, or how long the expiry is.
- The spec does not say whether a read that falls back writes the value it found back into the hot copy.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-26
- [authoritative-balance](authoritative-balance.md)
- [balance-controller](balance-controller.md)
- [balance-source](balance-source.md)
- [durable-copy](durable-copy.md)
- [get-shop-balance](get-shop-balance.md)
- [ledger-entry-table](ledger-entry-table.md)
- [read-model](read-model.md)
- [running-balance](running-balance.md)
- [shop-member](shop-member.md)
<!-- used-by:end -->
