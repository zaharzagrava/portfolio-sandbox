---
id: shop-offboarding
title: Shop offboarding
kind: term
status: draft
aliases: [offboard]
defined_for: S03-shops-rbac
rules_hash: dd6dcff82135
---
# Shop offboarding
## Definition
Shop offboarding is how an owner closes their shop. Only an [`OWNER`](shop-role.md) can start it or cancel it, and they must type the [shop slug](shop-slug.md) as confirmation. Starting it twice gives the same answer and [publishes no second event ↗](../sw-external-terms.md#transactional-outbox). Later, the hourly [`tenancy.purge-deleted-shops`](shop-purge-job.md) job [purges](shop-purge.md) each due shop, which leaves only a [tombstone](shop-tombstone.md). A [suspended](shop-status.md) shop cannot be closed through the API.

## Example
```
POST   /shops/:shopId/offboarding   (confirmation = the shop slug)  → offboarding starts
DELETE /shops/:shopId/offboarding                                  → the owner cancels
```
After the purge, only a tombstone remains: status `DELETED`, name `[deleted]` and slug `deleted-<id>`. The purge also publishes [`tenancy.shop_deleted`](shop-deleted-event.md). Before closing, the owner can download the shop's data with [`GET /shops/:shopId/export`](get-shop-export.md).

## Known gaps
- The spec does not say how long a shop waits between the start and the purge, or until when it can be cancelled.
- The spec does not name the event published when offboarding starts.
- The spec does not say which error answers a request to close a suspended shop.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-26
- [confirmation-mismatch](confirmation-mismatch.md)
- [purge-at](purge-at.md)
- [shop-offboarding-cancelled-event](shop-offboarding-cancelled-event.md)
- [shop-purge-job](shop-purge-job.md)
- [shop-purge](shop-purge.md)
- [shop-slug](shop-slug.md)
- [shop-status](shop-status.md)
- [shop-tombstone](shop-tombstone.md)
<!-- used-by:end -->
