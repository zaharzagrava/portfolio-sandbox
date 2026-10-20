---
id: sync-trigger
title: Sync trigger
kind: term
status: draft
aliases: [next trigger]
defined_for: J04-catalog-sync-to-search
rules_hash: 6156978c4fde
---
# Sync trigger
## Definition
Any later occurrence that makes the [catalog and Shopify stock sync](stock-sync-trigger.md) run again. A sale is accepted by the catalog even if Shopify fails. Any difference left by that failure is fixed by the next trigger, and the sale is not reversed. The journey names three sync paths: a catalog stock event [push](shopify-push-pull.md)ed by [`integrations-stock-push`](integrations-stock-push-queue.md), a [Shopify webhook](shop-webhook.md), and the [scheduled pull](scheduled-pull.md).

## Example
From J04 B-16: Shopify answers `503`. A device sells 2 from 10 and the push answers at once with [`quantityAfter 8`](quantity-after.md). On the next trigger, Shopify is set to 8.

## Known gaps
- The spec does not list exactly what counts as a trigger.
- The spec does not say whether a failed Shopify write is retried by itself, or waits for the next unrelated change or pull.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): R-16
- [scheduled-pull](scheduled-pull.md)
<!-- used-by:end -->
