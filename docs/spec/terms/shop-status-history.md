---
id: shop-status-history
title: Shop status history
kind: term
status: draft
aliases: [status history]
defined_for: S03-shops-rbac
rules_hash: 23751e7c28db
---
# Shop status history
## Definition
Shop status history is the record of a [shop's status](shop-status.md) changes over time, such as becoming [suspended](shop-status.md), reinstated or [deleting](shop-status.md). It belongs to the shop's lifecycle data in [tenancy](tenancy-domain-layer.md). The purge deletes it, so no history remains on the shop tombstone.

## Example
An admin calls `POST /admin/shops/:shopId/suspend` and later `POST /admin/shops/:shopId/reinstate`. Each change adds an entry to the shop's status history. When the shop is purged, all of these entries are deleted.

## Known gaps
- The spec does not say what each history entry holds, such as actor, reason or timestamp.
- The spec does not say whether any record of the shop's status changes survives the purge elsewhere, for example in the audit log.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-27, B-22
- [shop-purge-job](shop-purge-job.md)
- [shop-purge](shop-purge.md)
- [shop-status](shop-status.md)
- [shop-tombstone](shop-tombstone.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
<!-- used-by:end -->
