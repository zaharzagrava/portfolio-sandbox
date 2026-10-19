---
id: op-id
title: opId
kind: term
status: draft
aliases: []
defined_for: J04-catalog-sync-to-search
rules_hash: e3b0c44298fc
---
# opId
## Definition
`opId` is the identifier a device attaches to each operation it pushes, such as a [till sale](till.md). The [catalog](catalog-stock.md) applies a sale exactly once per `(shopId, opId)`. If the same `opId` is sent again, the [stored outcome](stock-operation-replayed.md) is returned. The replay causes no second catalog stock change and no second Shopify write. Two different shops can use the same `opId` without clashing, because the pair includes the [`shopId`](shop-id-param.md).

## Example
A device pushes a sale of `Ps` with `opId: "op-7"` (illustrative). The catalog lowers stock and the answer includes [`quantityAfter`](quantity-after.md). The device then resends `"op-7"` and gets the same answer, and stock does not move again.

## Known gaps
- The spec does not say what format an `opId` has, or that the device must generate it.
- The spec does not say how long stored outcomes are kept, so it does not say when a resent `opId` would stop being recognised.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
