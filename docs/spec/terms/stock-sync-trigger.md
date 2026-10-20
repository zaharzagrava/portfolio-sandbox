---
id: stock-sync-trigger
title: Stock sync trigger
kind: term
status: draft
aliases: [triggers]
defined_for: J04-catalog-sync-to-search
rules_hash: 0757fe759cef
---
# Stock sync trigger
## Definition
A stock sync trigger is any later event that makes the catalog and Shopify compare stock again. The trigger repairs a difference left by a failed [stock push](stock-push.md). The repair does not reverse a sale the catalog already accepted. This is how a Shopify outage is fixed without blocking [the till](till.md).

## Example
Shopify answers `503`. A device sells 2 from 10, and the push answers at once with `[quantityAfter](quantity-after.md) 8`. Shopify keeps the old quantity until the next trigger writes the difference.

## Known gaps
- The spec does not list which events count as triggers. Possible triggers include a later stock change, a [Shopify webhook](shop-webhook.md), the [scheduled pull](scheduled-pull.md), or a retry of the failed write; none is confirmed.
- The spec does not give a time limit for the repair. The bounds named H3 to H15 are not defined.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
