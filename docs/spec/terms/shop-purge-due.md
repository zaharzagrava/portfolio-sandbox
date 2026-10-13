---
id: shop-purge-due
title: Due shop (purge)
kind: term
status: draft
aliases: [becomes due, due shop]
defined_for: S03-shops-rbac
rules_hash: 2c13a733daee
---
# Due shop (purge)
## Definition
A due shop is a shop that has been closed through shop offboarding and that the shop purge may now remove. The `tenancy.purge-deleted-shops` job picks up only due shops, and it purges each one once. A shop becomes due only after its offboarding has started. The API cannot close a [suspended](shop-status.md) shop, so a suspended shop cannot become due that way.

## Example
An owner of the shop `acme-tools` (illustrative) calls `POST /shops/:shopId/offboarding` with the slug `acme-tools` as confirmation. The shop does not become due straight away. Once it is due, the next run of `tenancy.purge-deleted-shops` turns it into a [tombstone](shop-tombstone.md).

## Known gaps
- The spec does not say exactly when a shop becomes due, for example how long it waits after offboarding starts.
- The spec does not say whether `DELETE /shops/:shopId/offboarding` makes a shop stop being due, or until when it can still be cancelled.
- Not confirmed in the code: whether the due condition is based on `purgeAt` or on the shop status `DELETING`.

## Used by
<!-- used-by:start -->
- [purge-at](purge-at.md)
- [shop-purge](shop-purge.md)
- [shop-status](shop-status.md)
- [shop-tombstone](shop-tombstone.md)
- [tenancy-purge-deleted-shops-job](tenancy-purge-deleted-shops-job.md)
<!-- used-by:end -->
