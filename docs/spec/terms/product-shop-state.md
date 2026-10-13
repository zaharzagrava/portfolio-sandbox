---
id: product-shop-state
title: ProductShopState
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# ProductShopState
## Definition
`ProductShopState` is a table owned by the catalog capability. The spec lists it among the catalog's tables but does not describe its columns or purpose. The name suggests it stores per-shop state that the catalog needs, such as the shop status and [`shopVersion`](shop-version.md) it keeps from [`tenancy.shop_status_changed`](shop-status-changed-event.md). Keeping that state locally lets the catalog check public visibility without calling the tenancy domain. This is design intent (not stated in the spec), and it fits the rule that `Product` has no foreign key to `Shop`.

## Example
Illustrative only, assuming the table holds the status copy: after the consumer accepts a suspension at `shopVersion: 5`, the shop's row would show `SUSPENDED` with version `5`. A later event with `shopVersion: 4` would leave that row unchanged.

## Known gaps
- The spec does not say what columns `ProductShopState` has or what it stores. Every statement about its contents on this page is inferred from the name.
- Not confirmed in the code: that [`ShopStatusConsumer`](shop-status-consumer.md) writes to this table, or that the visibility check ([`isPubliclyVisible`](is-publicly-visible.md)) reads from it.
- The spec does not say whether rows are removed when the catalog handles [`tenancy.shop_deleted`](shop-deleted-event.md).

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
