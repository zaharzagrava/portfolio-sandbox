---
id: max-owned-shops
title: MAX_OWNED_SHOPS
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: 9ed275472427
---
# MAX_OWNED_SHOPS
## Definition
`MAX_OWNED_SHOPS` is the constant in the [slug and seat domain code](tenancy-domain-layer.md) that caps how many shops one user may own as [`OWNER`](shop-role.md). [`POST /shops`](post-shops.md) checks it before creating a shop. When a create would go over the cap, the request fails with [`shop_limit_reached`](shop-limit-reached.md) and nothing is stored. The cap must hold even when one user sends several creates at the same time. It lives in `packages/backend/libs/domains/tenancy/domain/seat-policy.ts`, next to the [per-plan seat limit](seat.md), but it counts owned shops, not seats.

## Example
A user who already owns 10 shops (the value in S03.R-12) calls `POST /shops` with a free slug:
```http
409 { "code": "shop_limit_reached", ... }
```
No shop, membership or [`tenancy.shop_created` event](shop-created-event.md) is created (S03.B-02).

## Known gaps
- The spec does not say whether shops in [`DELETING`](shop-status.md) or `DELETED` status, or [sandbox shops](sandbox-shop.md), count toward the cap.
- The spec does not say whether the cap is checked when a user becomes `OWNER` through a role change (`PATCH /shops/:shopId/members/:userId`). It only covers shop creation.
- The spec does not say how the cap is enforced under concurrent creates (lock, [serializable scope](serializable-scope.md) or a constraint). It only says the cap must hold.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-12
- [ensure-sandbox-shop](ensure-sandbox-shop.md)
- [legacy-seller](legacy-seller.md)
- [sandbox-shop](sandbox-shop.md)
- [seat](seat.md)
- [serializable-scope](serializable-scope.md)
- [shop-created-event](shop-created-event.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
<!-- used-by:end -->
