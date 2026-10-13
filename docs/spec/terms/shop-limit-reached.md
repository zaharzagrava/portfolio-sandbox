---
id: shop-limit-reached
title: shop_limit_reached (409)
kind: term
status: draft
aliases: [shop_limit_reached]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# shop_limit_reached (409)
## Definition
`shop_limit_reached` is the [conflict error](conflict-error.md) returned when creating a shop would make the caller own more shops than allowed. When it is returned, nothing is stored. The limit holds even when the same user sends several creates at the same time. The limit value is the constant [`MAX_OWNED_SHOPS`](max-owned-shops.md).

## Example
A user who already owns 10 shops calls [`POST /shops`](post-shops.md) and gets:
```http
409 { "code": "shop_limit_reached", ... }
```
No shop, [membership](shop-membership.md) or event is created.

## Known gaps
- The spec does not say whether shops in [`DELETING`](shop-status.md) or `DELETED` status, or [sandbox shops](sandbox-shop.md), count toward the limit.
- The spec does not say whether shops where the user is [`OWNER`](shop-role.md) through a role change (not creation) count. The rule says "own", which suggests they do.

## Used by
<!-- used-by:start -->
- [conflict-error](conflict-error.md)
- [post-shops](post-shops.md)
- [sandbox-shop](sandbox-shop.md)
- [shop-membership](shop-membership.md)
<!-- used-by:end -->
