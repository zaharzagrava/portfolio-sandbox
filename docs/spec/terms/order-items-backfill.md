---
id: order-items-backfill
title: Order items backfill
kind: term
status: draft
aliases: [backfill]
defined_for: S10-cart-checkout
rules_hash: ca8dccbca108
---
# Order items backfill
## Definition
This is a [repeating job](job.md), [`orders.backfill-item-titles`](orders-backfill-item-titles-job.md), that repairs older order items. It gives an item with no title the product's current title. If the product no longer exists, it uses `(removed product)` instead. It also sets the item's [`lineTotalMinor`](line-total-minor.md) to [unit price](unit-price-minor.md) × quantity. The job works in [bounded batches](bounded-batch.md) and keeps running [on its schedule](time-zone-aware-cron.md) until nothing is left to fix. Running it twice, or on two instances at once, has one effect.

## Example
An order item has no title and its product has been deleted. After the backfill it reads:
```json
{"title": "(removed product)", "unitPriceMinor": 1500, "quantity": 2, "lineTotalMinor": 3000}
```
The numbers and the `unitPriceMinor` field name are illustrative.

## Known gaps
- The spec does not say how the backfill handles discounts. Checkout defines a line total as unit price × quantity − discount, but the backfill sets unit price × quantity. A backfilled item with a discount would therefore disagree with the checkout rule.
- The spec does not say whether the backfill overwrites an existing `lineTotalMinor` or only fills in a missing one.
- The spec does not say how the job detects that "nothing is left" or what then stops the schedule.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-45
- [S14](../capabilities/S14-ledger-reconciliation.md): R-44
- [bounded-batch](bounded-batch.md)
- [job](job.md)
- [time-zone-aware-cron](time-zone-aware-cron.md)
- [unit-price-minor](unit-price-minor.md)
<!-- used-by:end -->
