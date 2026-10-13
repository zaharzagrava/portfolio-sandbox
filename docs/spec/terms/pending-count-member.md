---
id: pending-count-member
title: Pending count member
kind: term
status: draft
aliases: [member]
defined_for: S05-products
rules_hash: ad7af73be4c6
---
# Pending count member
## Definition
A pending count member is one entry in the [pending view counts](view-count-claim.md), the product views recorded but not yet stored. Each member names one product and holds that product's unflushed views. The [view count flush](view-count-flush.md) claims the members and applies them in [chunks](view-count-chunk.md). Members from a chunk that failed or never ran go back to the pending counts. A member whose name is not a [UUID ↗](../sw-external-terms.md#uuid) is skipped and counted, not applied.

## Example
A product is read five times, so its member holds 5 pending views. The next flush stores `viewCount: 5` and leaves the product's [`version`](product-version.md) unchanged. A member named `abc` (not a UUID) is skipped, and the skip is counted.

## Known gaps
- The spec does not say where the pending counts are stored, for example in the [shared cache store](l2-cache.md) or in a database table.
- The spec does not say where skipped members are counted, for example in a metric or a log, or under what name.
- The spec does not say whether a skipped non-UUID member is deleted or stays pending.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-22
- [l2-cache](l2-cache.md)
- [view-count-chunk](view-count-chunk.md)
- [view-count-claim](view-count-claim.md)
- [view-count-flush](view-count-flush.md)
<!-- used-by:end -->
