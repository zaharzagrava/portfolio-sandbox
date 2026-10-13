---
id: purge-at
title: purgeAt
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# purgeAt
## Definition
`purgeAt` is the moment when a [closing shop](shop-offboarding.md) becomes [due for the purge](shop-purge-due.md). Starting offboarding sets it. Cancelling offboarding with [`DELETE /shops/:shopId/offboarding`](delete-shop-offboarding.md) clears it and puts the shop back to [`ACTIVE`](shop-status.md). The [`tenancy.purge-deleted-shops` job](tenancy-purge-deleted-shops-job.md) picks up shops whose `purgeAt` has passed. It turns each one into a [tombstone](shop-tombstone.md) in its own transaction.

## Example
An owner starts offboarding, and the shop now has a `purgeAt` (for example `2026-11-12T10:00:00Z`, illustrative). The owner changes their mind and calls `DELETE /shops/:shopId/offboarding`. The shop is `ACTIVE` again with no `purgeAt`.

## Known gaps
- The spec does not say how far in the future `purgeAt` is set when offboarding starts.
- The spec does not say whether `purgeAt` appears in API responses such as `GET /shops/:shopId`.

## Used by
<!-- used-by:start -->
- [shop-offboarding](shop-offboarding.md)
- [shop-purge-due](shop-purge-due.md)
- [shop-tombstone](shop-tombstone.md)
- [tenancy-purge-deleted-shops-job](tenancy-purge-deleted-shops-job.md)
<!-- used-by:end -->
