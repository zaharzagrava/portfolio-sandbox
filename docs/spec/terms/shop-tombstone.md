---
id: shop-tombstone
title: Shop tombstone
kind: term
status: draft
aliases: [tombstone]
defined_for: S03-shops-rbac
rules_hash: 473068d09350
---
# Shop tombstone
## Definition
The shop tombstone is the shop row that remains after the purge. Its status is [`DELETED`](shop-status.md), its name is replaced with `[deleted]`, and its [slug](shop-slug.md) is replaced with `deleted-<id>`. Nothing hangs off it: no members, [invites](pending-invite.md), [SSO configuration](shop-sso-config.md), [directory row](directory-row.md) or [status history](shop-status-history.md). A deleted shop answers `[404 shop_not_found](shop-not-found.md)` like any unknown shop. Design intent (not stated in the spec): the row is kept so the shop identifier stays known and other [capabilities](capability.md)' references to it do not point at nothing.

## Example
```json
{ "id": "shop_123", "name": "[deleted]", "slug": "deleted-shop_123", "status": "DELETED" }
```
(The id is illustrative.) `GET /shops/shop_123` now answers `404 shop_not_found`.

## Known gaps
- The spec does not say whether the shop's original slug can be claimed by a new shop after the purge.
- The spec does not say which fields are kept on the tombstone besides status, name and slug, such as plan or verification.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-27, B-25
- [capability](capability.md)
- [directory-row](directory-row.md)
- [pending-invite](pending-invite.md)
- [purge-at](purge-at.md)
- [search-document](search-document.md)
- [shop-offboarding](shop-offboarding.md)
- [shop-purge-due](shop-purge-due.md)
- [shop-purge-job](shop-purge-job.md)
- [shop-purge](shop-purge.md)
- [shop-slug](shop-slug.md)
- [shop-sso-config](shop-sso-config.md)
- [shop-status-history](shop-status-history.md)
- [tenancy-purge-deleted-shops-job](tenancy-purge-deleted-shops-job.md)
<!-- used-by:end -->
