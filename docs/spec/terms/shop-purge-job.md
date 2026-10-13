---
id: shop-purge-job
title: Shop purge job
kind: term
status: draft
aliases: [purge job]
defined_for: S03-shops-rbac
rules_hash: 781b0cfe38ca
---
# Shop purge job
## Definition
The shop purge job is the [scheduled job](job.md) `tenancy.purge-deleted-shops`. It permanently closes shops whose [offboarding](shop-offboarding.md) has reached its [`purgeAt`](purge-at.md) time. It handles each due shop once, in its own transaction, and turns the shop into a [tombstone](shop-tombstone.md). The tombstone keeps no member, pending invite, [SSO configuration](shop-sso-config.md), [directory row](shop-cell-directory-row.md) or [status history](shop-status-history.md). The job also publishes [`tenancy.member_removed`](member-removed-event.md) (reason `shop_deleted`) and [`tenancy.shop_deleted`](shop-deleted-event.md), and ends the sessions of former members whose source is [`sso`](membership-removal-source.md).

## Example
An owner starts offboarding with `POST /shops/:shopId/offboarding`. If the job runs before `purgeAt`, nothing changes. After `purgeAt`, the shop becomes this tombstone:
```json
{ "status": "DELETED", "name": "[deleted]", "slug": "deleted-<id>" }
```
The old slug can then be registered again, and the former owner gets [`404 shop_not_found`](shop-not-found.md).

## Known gaps
- The spec does not say how long the time between starting offboarding and `purgeAt` is, or where that time is configured.
- The spec does not say what happens to a shop that is [suspended](shop-status.md) while it is closing. It only says a suspended shop cannot be closed through the API.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-25
- [job](job.md)
- [shop-cell-directory-row](shop-cell-directory-row.md)
- [shop-offboarding](shop-offboarding.md)
- [shop-sso-config](shop-sso-config.md)
- [shop-status-history](shop-status-history.md)
- [shop-status](shop-status.md)
- [shop-tombstone](shop-tombstone.md)
<!-- used-by:end -->
