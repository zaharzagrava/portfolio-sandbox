---
id: shopify-write
title: Shopify write
kind: term
status: draft
aliases: [shopify push]
defined_for: J04-catalog-sync-to-search
rules_hash: 8acb580defbd
---
# Shopify write
## Definition
A Shopify write is the outbound call that sets the Shopify inventory of a [linked product](shopify-link.md). It is a [conditional absolute write](conditional-absolute-write.md): it sends the new quantity together with the quantity it expects Shopify to hold. If Shopify holds a different value, the write is refused and the [three-way merge](stock-three-way-merge.md) runs. Products that are not linked never cause one. An [echo](shopify-echo.md) or a [replay](stock-operation-replayed.md) causes no second write.

## Example
```
set 8, expected 10   → refused (Shopify sold 3 meanwhile; it now holds 7)
merge: 8 + 7 − 10 = 5 → both sides set to 5
```
If Shopify answers `503`, the sale is still kept (`[quantityAfter](quantity-after.md) 8`), and the [next trigger](stock-sync-trigger.md) repairs Shopify.

## Known gaps
- The spec does not say what counts as "the next trigger" that repairs a failed write. It could be a later push, a webhook or the [scheduled pull](shopify-scheduled-pull.md).
- The spec does not give a retry count or a time limit for repairing Shopify.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
