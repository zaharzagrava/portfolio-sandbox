---
id: get-shop-orders
title: GET /shops/:shopId/orders
kind: term
status: draft
aliases: [/shops/:shopid/orders]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# GET /shops/:shopId/orders
## Definition
`GET /shops/:shopId/orders` lists one shop's slice of orders, meaning the [shop orders](shop-order.md) that belong to that seller. Only shop members with the [`orders.read`](permission.md) permission can call it. Results use keyset pagination, and an optional `status` filter narrows the list. It lives in `ShopOrdersController` in the orders domain. Sellers use this route because `GET /orders/:orderId` answers [`404 order_not_found`](order-not-found.md) to anyone who is not the buyer.

## Example
A staff member of shop `shp_42` (illustrative) has `orders.read` and wants paid orders only:
```
GET /shops/shp_42/orders?status=PAID
```
The response lists only `shp_42`'s shop orders. Other sellers' parts of the same buyer orders are not in the list.

## Known gaps
- The spec does not say what a caller without `orders.read`, or a non-member, gets back (for example [`403 permission_denied`](permission-denied.md) or [`404 shop_not_found`](shop-not-found.md)).
- The spec does not say whether `status` filters on the [order status](order-status.md) or on a separate shop order status, or which values it accepts.
- The spec does not give the page size, the cursor parameter name or the fields returned for each shop order.

## Used by
<!-- used-by:start -->
- [order-status](order-status.md)
- [shop-order](shop-order.md)
<!-- used-by:end -->
