---
id: shop-guard
title: ShopGuard
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# ShopGuard
## Definition
`ShopGuard` is the request guard in the [tenancy `api` folder](tenancy-domain-layer.md) that decides which shop a request is about. It takes the shop from the URL path or the [`X-Shop-Id` header](x-shop-id-header.md) and never from the request body. If the path and the header name different shops, it refuses the request with [`shop_mismatch`](shop-mismatch.md). Design intent (not stated in the spec): reading the shop only from the path or header stops a caller from slipping another shop's id into the body to reach that shop.

## Example
The path and the header name different shops, so the request is refused (the ids are illustrative):
```
PATCH /shops/shop_A
X-Shop-Id: shop_B
→ 400 shop_mismatch
```

## Known gaps
- Not confirmed in the code: whether `ShopGuard` also checks membership and permissions and applies the [shop status gate](shop-status-gate.md). S03.R-04 sets the order of those answers but does not name the component that gives them.
- Not confirmed in the code: whether `ShopGuard` is where the once-per-request tenant resolution happens, or where the [tenant setting](tenant-setting.md) for [tenancy tables](tenancy-tables.md) is applied.
- The spec does not say which routes use `ShopGuard`. Routes such as `GET /shops/mine` or `GET /batch/shops` have no shop in the path, and the spec does not say whether the guard runs on them.

## Used by
<!-- used-by:start -->
- [shop-status-gate](shop-status-gate.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
- [tenancy-tables](tenancy-tables.md)
- [tenant-setting](tenant-setting.md)
- [x-shop-id-header](x-shop-id-header.md)
<!-- used-by:end -->
