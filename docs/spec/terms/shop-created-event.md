---
id: shop-created-event
title: tenancy.shop_created event
kind: term
status: draft
aliases: [tenancy.shop_created]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# tenancy.shop_created event
## Definition
`tenancy.shop_created` is the event the tenancy capability publishes when a new shop exists. A successful `POST /shops` causes it. The event is written in the same transaction as the new shop, through the [outbox](inbox-table.md). If the outbox append fails, [the whole create rolls back](outbox-rollback.md), so no shop exists without its event. Other capabilities can use it to learn about new shops without reading tenancy tables.

## Example
A signed-in user calls `POST /shops` with a free slug (`"acme-ceramics"` is illustrative). The answer is `201` with plan [`STARTER`](plan-limit.md), status `ACTIVE`, verification [`UNVERIFIED`](shop-verification.md) and [`payoutsEnabled`](payouts-enabled.md) false (S03.B-01). In the same commit, one `tenancy.shop_created` row is appended to the outbox.
If the same user already owns 10 shops, the answer is `409 shop_limit_reached` and nothing is stored (S03.B-02), so no event is written either.

## Known gaps
- The spec does not say what is in the event payload, for example whether it includes the slug, plan or owner's user id.
- The spec does not say whether `ensureShopsForLegacySellers` or `ensureSandboxShop` emit `tenancy.shop_created` when they create a shop.
- The spec does not say which capabilities consume this event.

## Used by
<!-- used-by:start -->
- [inbox-table](inbox-table.md)
- [max-owned-shops](max-owned-shops.md)
- [outbox-rollback](outbox-rollback.md)
<!-- used-by:end -->
