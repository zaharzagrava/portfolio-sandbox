---
id: pagination-cursor
title: Pagination cursor (nextCursor)
kind: term
status: draft
aliases: [cursor, nextcursor]
defined_for: S03-shops-rbac
rules_hash: a312719cd2e3
---
# Pagination cursor (nextCursor)
## Definition
`nextCursor` is an [opaque value](pagination-cursor.md) returned with a page of a [cursor-paginated list](pagination-cursor.md). The client sends it back to get the next page. It must not parse it or build it by hand. When there are no more items, `nextCursor` is `null`.

## Example
A user belongs to three [shops](shop-tenant.md). [`GET /shops/mine?limit=2`](get-shops-mine.md) returns two shops and a `nextCursor` (for example `"eyJ..."`, illustrative). Requesting the next page with that cursor returns the third shop and `"nextCursor": null`.

## Known gaps
- The spec does not name the query parameter that carries the cursor back.
- The spec does not say how items are ordered, whether a cursor expires, or what the default and maximum `limit` are.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-44
- [S03](../capabilities/S03-shops-rbac.md): B-04
- [S05](../capabilities/S05-products.md): R-10
- [S10](../capabilities/S10-cart-checkout.md): R-37
- [S13](../capabilities/S13-payment-intents.md): B-21
- [S14](../capabilities/S14-ledger-reconciliation.md): R-23, R-38
- [S28](../capabilities/S28-notifications.md): R-38
- [S32](../capabilities/S32-product-search.md): R-10, R-34, R-45
- [barrel-export](barrel-export.md)
- [device-listing](device-listing.md)
- [foreign-cursor](foreign-cursor.md)
- [get-auth-sessions](get-auth-sessions.md)
- [get-notifications](get-notifications.md)
- [get-payments](get-payments.md)
- [get-shops-mine](get-shops-mine.md)
- [invalid-cursor](invalid-cursor.md)
- [keyset-pagination](keyset-pagination.md)
- [list-seller-balances](list-seller-balances.md)
- [notification-secret](notification-secret.md)
- [payments-domain-layer](payments-domain-layer.md)
- [product-search-route](product-search-route.md)
- [search-mode](search-mode.md)
- [search-page](search-page.md)
- [search-sort-order](search-sort-order.md)
- [shop-search-q-parameter](shop-search-q-parameter.md)
- [shop-tenant](shop-tenant.md)
- [stripe-statement-adapter](stripe-statement-adapter.md)
- [tampered-cursor](tampered-cursor.md)
<!-- used-by:end -->
