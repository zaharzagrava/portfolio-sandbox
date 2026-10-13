---
id: allowed-region
title: Allowed region
kind: term
status: draft
aliases: [region]
defined_for: S03-shops-rbac
rules_hash: eb8b86594239
---
# Allowed region
## Definition
An allowed region is one of the regions a shop's directory row may place the shop in. When a shop is created, its directory row gets the default region or the region the creator asked for, as long as that region is allowed. After that, only a [shop cell move](shop-cell-move.md) by a [platform administrator](platform-admin.md) can change the region. Design intent (not stated in the spec): this lets the platform control where a shop's data is kept, for example for [data-residency ↗](../sw-external-terms.md#data-residency) reasons.

## Example
A seller calls `POST /shops` and asks for an allowed region, here called `eu` (an illustrative name). The new directory row is `pooled`, version 1, region `eu`. Later the seller cannot change the region. Only an administrator's `PUT /admin/shops/:shopId/directory` can.

## Known gaps
- The spec does not say which regions are allowed, which one is the default, or where that list is configured.
- The spec does not say how a creator asks for a region in `POST /shops`, or what the answer is when they ask for a region that is not allowed.
- The spec does not say how a region relates to a [cell](shop-cell.md), for example whether every cell belongs to exactly one region.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-28
- [directory-row-version](directory-row-version.md)
- [platform-admin](platform-admin.md)
- [shop-cell-directory-row](shop-cell-directory-row.md)
- [shop-cell-move](shop-cell-move.md)
- [shop-cell](shop-cell.md)
<!-- used-by:end -->
