---
id: delete-shop-offboarding
title: DELETE /shops/:shopId/offboarding
kind: term
status: draft
aliases: [/shops/:shopid/offboarding, offboarding]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# DELETE /shops/:shopId/offboarding
## Definition
`DELETE /shops/:shopId/offboarding` cancels the closing of a shop. Only an [`OWNER`](shop-role.md) may call it. On a closing shop it puts the shop back to [`ACTIVE`](shop-status.md), clears [`purgeAt`](purge-at.md) and publishes [`tenancy.shop_offboarding_cancelled`](shop-offboarding-cancelled-event.md). On a shop that is already active it answers [`409 invalid_transition`](invalid-transition.md). It pairs with `POST /shops/:shopId/offboarding`, which starts the closing.

## Example
```
DELETE /shops/:shopId/offboarding   (closing shop)  → shop ACTIVE, purgeAt cleared, event published
DELETE /shops/:shopId/offboarding   (active shop)   → 409 invalid_transition
```

## Known gaps
- The spec does not say clearly whether cancelling also needs the slug as confirmation. S03.R-26 says "start or cancel … with the slug as confirmation", but the entry points list the slug only for starting.
- The spec does not say the success status code.
- The spec does not say what happens if the cancel arrives while the purge is already running for that shop.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
