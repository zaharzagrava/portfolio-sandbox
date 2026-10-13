---
id: shop-purge
title: Shop purge
kind: term
status: draft
aliases: [purge]
defined_for: S03-shops-rbac
rules_hash: 36187d000325
---
# Shop purge
## Definition
The shop purge is the step that finally removes a closed shop's tenancy data after offboarding. The [`tenancy.purge-deleted-shops`](tenancy-purge-deleted-shops-job.md) job picks up each [due](shop-purge-due.md) shop and purges it once, in its own transaction. What remains is a [shop tombstone](shop-tombstone.md). The purge publishes [`tenancy.member_removed`](member-removed-event.md) and [`tenancy.shop_deleted`](shop-deleted-event.md), and it ends the sessions of former [`sso` members](membership-removal-source.md). Each shop gets its own transaction. Design intent (not stated in the spec): this way one failing shop does not roll back the purge of the others.

## Example
An owner starts offboarding with `POST /shops/:shopId/offboarding` and confirms with the slug. Later the shop becomes due, and the next run of `tenancy.purge-deleted-shops` purges it. Its members, invites, [SSO configuration](shop-sso-config.md), [directory row](directory-row.md) and [status history](shop-status-history.md) are deleted. The events are published, and anyone who signed in through the shop's provider has their sessions ended.

## Known gaps
- The spec does not say how long a shop waits between the start of offboarding and becoming due for the purge.
- The spec does not say what a purge failing halfway does for that shop, for example whether the next hourly run retries it.
- Not confirmed in the code: the selection of "due" shops. The facts only point to `ShopLifecycleService` and `PurgeShopsJobs`.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-27
- [catalog-product-events](catalog-product-events.md)
- [delete-shop-sso](delete-shop-sso.md)
- [directory-row](directory-row.md)
- [member-removed-event](member-removed-event.md)
- [membership-removal-source](membership-removal-source.md)
- [shop-offboarding-cancelled-event](shop-offboarding-cancelled-event.md)
- [shop-offboarding](shop-offboarding.md)
- [shop-purge-due](shop-purge-due.md)
- [shop-sso-config](shop-sso-config.md)
- [shop-status-history](shop-status-history.md)
- [shop-tombstone](shop-tombstone.md)
- [tenancy-purge-deleted-shops-job](tenancy-purge-deleted-shops-job.md)
<!-- used-by:end -->
