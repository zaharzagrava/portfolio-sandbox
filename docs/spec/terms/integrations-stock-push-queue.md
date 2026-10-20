---
id: integrations-stock-push-queue
title: integrations-stock-push queue
kind: term
status: draft
aliases: [integrations-stock-push]
defined_for: J04-catalog-sync-to-search
rules_hash: 4731bf8e311a
---
# integrations-stock-push queue
## Definition
`integrations-stock-push` is the [event consumer](event-consumer.md) that writes catalog stock changes to Shopify. It acts only on Shopify-linked products; a product that is not linked causes no Shopify call. Each write is a conditional absolute write. If Shopify's stock has changed in the meantime, the write is refused and the two sides are merged as `local + remote − base`. A Shopify echo of the marketplace's own write causes no new write, and a Shopify outage never blocks or reverses a sale in the catalog.

## Example
Catalog and Shopify both hold 10. A device sells 2, and Shopify sells 3 before the push. The write "set 8, expected 10" is refused, and the merge gives 5 on both sides. If the merge would be negative, both sides are set to 0 and one `catalog_sync.stock_conflict_opened` is raised.

## Known gaps
- The spec does not say this is a queue. The facts call it a consumer.
- The spec does not say what "the next trigger" is that repairs Shopify after a `503`, or how quickly that repair happens.
- The spec does not say which capability owns this consumer. The Shopify integration is S08, but ownership is not stated.

## Used by
<!-- used-by:start -->
- [shopify-connection](shopify-connection.md)
- [shopify-push-pull](shopify-push-pull.md)
<!-- used-by:end -->
