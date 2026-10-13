---
id: orders-backfill-item-titles-job
title: orders.backfill-item-titles job
kind: term
status: draft
aliases: [orders.backfill-item-titles]
defined_for: S10-cart-checkout
rules_hash: 3c7c66e897c1
---
# orders.backfill-item-titles job
## Definition
`orders.backfill-item-titles` is a recurring job in the [orders domain](orders-domain.md) that repairs older order items. It gives each item that has no title the product's current title from the catalog. If the product no longer exists, the item gets `(removed product)` as its title. The job also sets the item's [`lineTotalMinor`](line-total-minor.md) to [unit price](unit-price-minor.md) × quantity. It works through items in [bounded batches](bounded-batch.md) and runs [on its schedule](job.md) until no items are left to fix. [Running it twice, or on two instances at once, gives the same result as running it once. ↗](../sw-external-terms.md#idempotency)

## Example
An old order item has no title, and its product has since been deleted. After a backfill run, the item reads:
```json
{"title": "(removed product)", "unitPriceMinor": 1500, "quantity": 2, "lineTotalMinor": 3000}
```
The numbers are illustrative.

## Known gaps
- The spec does not say how the backfill handles [discounts](seller-discount.md). S10.R-15 defines a line total as unit price × quantity − discount, but the backfill sets unit price × quantity. A backfilled item that had a discount would break that rule.
- The spec does not say whether the backfill overwrites an existing `lineTotalMinor` or only fills in a missing one.
- The spec does not say how the job detects that nothing is left, or what removes or stops its schedule afterwards.

## Used by
<!-- used-by:start -->
- [bounded-batch](bounded-batch.md)
- [job](job.md)
- [line-total-minor](line-total-minor.md)
- [orders-domain](orders-domain.md)
- [seller-discount](seller-discount.md)
- [unit-price-minor](unit-price-minor.md)
<!-- used-by:end -->
