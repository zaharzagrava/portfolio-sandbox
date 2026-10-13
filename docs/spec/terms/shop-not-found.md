---
id: shop-not-found
title: shop_not_found (404)
kind: term
status: draft
aliases: [shop_not_found]
defined_for: tenant-shop-rbac
rules_hash: e3b0c44298fc
---
# shop_not_found (404)
## Definition
`shop_not_found` is the `404` error a caller gets when they may not see a shop. A [non-member](shop-role.md), an unknown shop, a malformed shop identifier and a deleted shop all get this same answer. Reading another [tenant's aggregate](aggregate-id.md) also gets this answer. In the answer order it comes right after [`invalid_token`](invalid-token-error.md) and before [`permission_denied`](permission-denied.md). Giving every case the same answer stops callers from learning whether a shop exists. That is design intent (not stated in the spec).

## Example
Tenant B reads an aggregate that belongs to tenant A, using [`minVersion=1`](min-version.md). Tenant B gets `404` and no [checkpoint lookup](checkpoint-lookup.md) runs (S53.B-19). A request for a shop ID that is badly formed gets the same `404 shop_not_found` as a request for a deleted shop.

## Known gaps
- The spec does not say what the problem body contains besides the code.
- The spec does not say whether a `SUSPENDED` shop counts as found. The order of answers suggests it does, because the status gate comes after `404`.

## Used by
<!-- used-by:start -->
- [aggregate-id](aggregate-id.md)
- [checkpoint-lookup](checkpoint-lookup.md)
- [shop-role](shop-role.md)
<!-- used-by:end -->
