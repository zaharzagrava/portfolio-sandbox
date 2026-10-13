---
id: post-shops
title: POST /shops
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# POST /shops
## Definition
`POST /shops` is the endpoint a signed-in user calls to create a new shop. The caller becomes the shop's [`OWNER`](shop-role.md). A new shop starts on the [`STARTER` plan](plan-limit.md) with [status `ACTIVE`](shop-status.md) and [verification `UNVERIFIED`](shop-verification.md), and [`payoutsEnabled`](payouts-enabled.md) is false. The slug must pass the [slug rules](slug-policy.md). The caller must also stay under the [owned-shops limit](shop-limit-reached.md), and this holds even when creates run at the same time.

## Example
```http
POST /shops
{ "name": "Acme Ceramics", "slug": "acme-ceramics" }   // illustrative body
→ 201 { ..., "plan": "STARTER", "status": "ACTIVE", "verification": "UNVERIFIED", "payoutsEnabled": false }
```
Possible failures: [`401 invalid_token`](invalid-token-error.md), [`422 slug_reserved`](reserved-slug.md), [`409 slug_taken`](slug-taken.md), `409 shop_limit_reached`.

## Known gaps
- The spec does not list the exact request body fields. Only the slug is mentioned.
- Not confirmed in the code: whether the [`tenancy.shop-create.user` rate-limit policy](rate-limit-policy.md) applies to this route, and what its values are.
- Not confirmed in the code: whether this route emits `tenancy.shop_created` and `tenancy.member_added` [in the same transaction](active-transaction.md).

## Used by
<!-- used-by:start -->
- [active-transaction](active-transaction.md)
- [plan-limit](plan-limit.md)
- [rate-limit-policy](rate-limit-policy.md)
- [shop-limit-reached](shop-limit-reached.md)
- [shop-status](shop-status.md)
- [shop-verification](shop-verification.md)
- [slug-policy](slug-policy.md)
<!-- used-by:end -->
