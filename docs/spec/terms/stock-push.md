---
id: stock-push
title: Stock push
kind: term
status: draft
aliases: [pushes]
defined_for: J04-catalog-sync-to-search
rules_hash: a76bcbcd90c3
---
# Stock push
## Definition
A stock push writes a catalog stock change to Shopify. The `integrations-stock-push` consumer performs it, but only for Shopify-linked products. Products that are not linked cause no Shopify call. Each push is a conditional absolute write: it sets an exact quantity and expects a known current one. If Shopify refuses the write, the stock merge runs. The catalog never waits for the push, so a sale stands even when Shopify is down.

## Example
`Ps` is at 10 and a device sells 2. The push sends "set 8, expected 10" to Shopify. While the consumer is paused, sales of 1, 1 and 2 cause no Shopify write. One write follows after resume.

## Known gaps
- The text also uses "push" for a device sending its sales to the catalog (with `delta` and `opId`). Those are different operations.
- The spec does not say how several pending changes become one write after a pause. Only the observed result of one write is given.
- The spec does not say how many retries the push makes, or how long it waits between them after a Shopify `503`.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): B-14
- [conditional-absolute-write](conditional-absolute-write.md)
- [stock-merge](stock-merge.md)
- [stock-sync-trigger](stock-sync-trigger.md)
<!-- used-by:end -->
