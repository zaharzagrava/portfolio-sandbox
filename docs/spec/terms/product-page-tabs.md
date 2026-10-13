---
id: product-page-tabs
title: Product page tabs (?tab=)
kind: term
status: draft
aliases: [?tab=discussions, tab]
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# Product page tabs (?tab=)
## Definition
The product page splits its content into tabs: Details, [Pickup near me](pickup-near-me.md), Ask about this product, and a tab where shoppers talk about the product with each other. The `tab` query parameter selects which panel opens. This lets a link point straight at one panel of a product, such as the one with shopper conversations.

## Example
`/products/<productId>?tab=discussions` opens the product page with the Discussions panel open. The short link [`/p/<productId>?tab=discussions`](product-short-link.md) redirects with [`308` ↗](../sw-external-terms.md#http-308-permanent-redirect) and keeps the query, so it opens the same panel.

## Known gaps
- The spec does not list the `tab` values for Details, Pickup near me or Ask about this product. Only `discussions` is named.
- The spec does not say what happens when `tab` has an unknown value, or which tab opens when there is no `tab`.
- Not confirmed in the code: the file reference for the product page could not be verified (`packages/web/app/products/[productId` was not found).

## Used by
<!-- used-by:start -->
- [pickup-near-me](pickup-near-me.md)
- [product-discussions](product-discussions.md)
<!-- used-by:end -->
