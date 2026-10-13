---
id: x-shop-id-header
title: X-Shop-Id header
kind: term
status: draft
aliases: [x-shop-id]
defined_for: tenant-shop-rbac
rules_hash: f3455655a5f5
---
# X-Shop-Id header
## Definition
`X-Shop-Id` is a request header that names the [shop](shop-tenant.md) a request is for. The shop comes either from the URL path or from this header. It never comes from the request body. If the request has both and they name different shops, the answer is [`400 shop_mismatch`](shop-mismatch.md).

## Example
```
GET /shops/shop_123/products        (illustrative path)
X-Shop-Id: shop_456                 (illustrative value)
→ 400 shop_mismatch
```

## Known gaps
- The spec does not say what happens if a request needs a shop but has neither the path nor the header.
- The spec does not say which routes take the shop from the path and which take it from the header.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-03
- [tenant-shop-rbac](../concepts/tenant-shop-rbac.md): C-02
- [get-shop-by-id](get-shop-by-id.md)
- [shop-guard](shop-guard.md)
- [shop-id-param](shop-id-param.md)
- [shop-tenant](shop-tenant.md)
- [tenant-setting](tenant-setting.md)
<!-- used-by:end -->
