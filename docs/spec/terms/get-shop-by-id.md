---
id: get-shop-by-id
title: GET /shops/:shopId
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# GET /shops/:shopId
## Definition
`GET /shops/:shopId` is the endpoint a shop member calls to read one shop. The answer holds the shop itself, plus the caller's [`myRole`](my-role.md) and [`myPermissions`](permission.md) in that shop. The shop is identified by the `:shopId` in the path. If an [`X-Shop-Id` header](x-shop-id-header.md) is also sent and names a different shop, the request fails with [`shop_mismatch`](shop-mismatch.md). Callers who are not members get the same [`shop_not_found`](shop-not-found.md) as callers asking for a shop that does not exist, so the endpoint never reveals which shops exist.

## Example
A [`STAFF` member](shop-role.md) reads their shop. The status and permission values are illustrative.
```json
{ "status": "ACTIVE", "myRole": "STAFF", "myPermissions": ["shop.read", "members.read"] }
```
Without credentials the same call returns `401 invalid_token`. For a non-member, an unknown id or a deleted shop it returns `404 shop_not_found`.

## Known gaps
- The spec does not say which permission this endpoint requires. If it is `shop.read`, the read still works on a `SUSPENDED` shop.
- The spec does not list the exact fields of the shop object in the answer. It names the plan, status, verification and `payoutsEnabled` only in the create response.
- The spec does not say whether `myRole` and `myPermissions` come from the authorization cache or the database. Right after a role change they may be briefly out of date.

## Used by
<!-- used-by:start -->
- [shop-role](shop-role.md)
- [x-shop-id-header](x-shop-id-header.md)
<!-- used-by:end -->
