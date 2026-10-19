---
id: shop-integration
title: Shop integration
kind: term
status: draft
aliases: []
defined_for: J04-catalog-sync-to-search
rules_hash: 954e20ad3564
---
# Shop integration
## Definition
A shop integration is a shop's connection to an external Shopify store. It is managed by a user holding [`integrations.manage`](permission.md). It is the link that lets products be [backfilled](shopify-backfill.md), [pulled](shopify-push-pull.md) and [pushed](shopify-push-pull.md) between Shopify and the catalog. Its routes belong to one shop. A route of another shop must not reach it, and gets `404` or `403` instead.

## Example
The owner of shop `SH` connects a Shopify store, and the [variants](shopify-variant.md) are backfilled (J04.B-05). A user of a different shop who calls `SH`'s integration route gets `404` or `403` (J04.R-20).

## Known gaps
- The spec does not say whether a shop can have more than one integration, or which providers other than Shopify exist.
- The spec does not say when the answer is `404` and when it is `403`.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
