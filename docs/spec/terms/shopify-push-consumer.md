---
id: shopify-push-consumer
title: Shopify push consumer
kind: term
status: draft
aliases: [push consumer]
defined_for: J04-catalog-sync-to-search
rules_hash: 02bff83a1ccd
---
# Shopify push consumer
## Definition
The Shopify push consumer is the [event consumer](event-consumer.md) [`integrations-stock-push`](integrations-stock-push-queue.md). It reads catalog stock changes from the [outbox](inbox-table.md) and writes the new quantity to Shopify. It does this only for products linked to Shopify, and each write is a [conditional absolute write](conditional-absolute-write.md). It is [idempotent ↗](../sw-external-terms.md#idempotency) and [version-guarded](version-guard.md), so a replay causes no second Shopify write. [Pausing](consumer-pause.md) it does not hold up the other consumers, and it catches up to [`lag: 0`](consumer-lag.md) after resume.

## Example
`integrations-stock-push` is paused, and three device pushes sell 1, 1 and 2 units of `Ps`. Nothing is written to Shopify while the consumer is paused. After resume, one write brings Shopify to the final quantity.

## Known gaps
- The spec does not say how often it retries after a refused or failed Shopify write. It says only that "[the next trigger](stock-sync-trigger.md)" repairs the difference.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
