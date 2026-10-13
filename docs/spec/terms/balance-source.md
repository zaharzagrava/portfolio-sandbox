---
id: balance-source
title: Balance source (read_model, ledger)
kind: term
status: draft
aliases: [source]
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# Balance source (read_model, ledger)
## Definition
The balance source is the `source` member of a balance response. It names the store that answered. [`read_model`](read-model.md) means the [hot copy](hot-copy.md) or the [durable copy](durable-copy.md) of the read model answered. `ledger` means both of those stores were down, so the read fell back to the ledger's [authoritative running balance](authoritative-balance.md). Both sources return the same number, though a read model answer may be slightly stale.

## Example
The read model's cache and durable stores are both unavailable, and a shop member calls [`GET /shops/:shopId/balance`](get-shop-balance.md). The response has `"source": "ledger"` and the same [`availableMinor`](available-minor.md) the read model would have given.

## Known gaps
- The spec does not say whether `source` tells the hot copy apart from the durable copy. Both appear to report `read_model`.

## Used by
<!-- used-by:start -->
- [authoritative-balance](authoritative-balance.md)
- [durable-copy](durable-copy.md)
- [hot-copy](hot-copy.md)
<!-- used-by:end -->
