---
id: shopify-push-pull
title: Shopify push and pull
kind: term
status: draft
aliases: [pulls, pushes]
defined_for: J04-catalog-sync-to-search
rules_hash: c85cdca625a0
---
# Shopify push and pull
## Definition
These are the two directions of stock and product sync between the catalog and a linked Shopify store.

**Push** sends catalog stock changes to Shopify. The [`integrations-stock-push` consumer](integrations-stock-push-queue.md) writes the new stock to Shopify as a [conditional absolute write](conditional-absolute-write.md). A product that is not linked to Shopify causes no Shopify call.

**Pull** brings Shopify changes into the catalog. A [webhook](shop-webhook.md) is the fast path, and a [scheduled pull](shopify-scheduled-pull.md) is the safety net that catches changes that arrived without a webhook.

Both directions must stop for a shop that is [not active](shop-status.md).

## Example
A [till](till.md) sells 2 units of `Ps`, so catalog stock goes from 10 to 8. The push sends "set 8, expected 10" to Shopify. Meanwhile Shopify sold 3, so the write is refused and [the merge](stock-three-way-merge.md) gives 5 (J04.B-14).

A title changed in Shopify with no webhook is picked up by the scheduled pull (J04.B-07).

## Known gaps
- The spec also uses "push" for a device sending sales (J04.B-16, J04.B-18). The facts do not say which meaning J04.R-19 intends.
- The spec does not say how often the scheduled pull runs. The time bounds H3–H15 are not defined in the facts.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
