---
id: shop-mismatch
title: shop_mismatch (400)
kind: term
status: draft
aliases: [shop_mismatch]
defined_for: tenant-shop-rbac
rules_hash: e3b0c44298fc
---
# shop_mismatch (400)
## Definition
`shop_mismatch` is the `400` error returned when the shop in the URL path and the shop in the `X-Shop-Id` header are different. The request is rejected instead of choosing one of them. This avoids any doubt about which tenant the request acts on. That is design intent (not stated in the spec).

## Example
The path names `shop_123` but the header says `X-Shop-Id: shop_456` (both values illustrative). The answer is `400 shop_mismatch`.

## Known gaps
- The spec does not say where this check falls in the answer order. For example, it does not say whether it runs before or after `401 invalid_token`.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
