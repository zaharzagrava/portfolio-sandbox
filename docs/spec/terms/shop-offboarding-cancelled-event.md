---
id: shop-offboarding-cancelled-event
title: tenancy.shop_offboarding_cancelled event
kind: term
status: draft
aliases: [tenancy.shop_offboarding_cancelled]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# tenancy.shop_offboarding_cancelled event
## Definition
`[tenancy](tenancy-domain-layer.md).shop_offboarding_cancelled` is the event that tenancy publishes when an owner cancels the [closing of a shop](shop-offboarding.md). It means the shop is [`ACTIVE`](shop-status.md) again and no [purge](shop-purge.md) is scheduled. Other capabilities can consume it to undo anything they prepared for the shop's deletion. That last point is design intent (not stated in the spec).

## Example
An owner calls [`DELETE /shops/:shopId/offboarding`](delete-shop-offboarding.md) on a closing shop. The shop returns to `ACTIVE`, its [`purgeAt`](purge-at.md) is cleared, and `tenancy.shop_offboarding_cancelled` is published.

## Known gaps
- The spec does not say the payload of the event.
- The spec does not say which capabilities consume it.

## Used by
<!-- used-by:start -->
- [shop-offboarding](shop-offboarding.md)
- [shop-purge](shop-purge.md)
<!-- used-by:end -->
