---
id: product-short-link
title: Product short link (/p/<productId>)
kind: term
status: draft
aliases: [/p/<productid>, short link]
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# Product short link (/p/<productId>)
## Definition
The product short link is the shorter `/p/<productId>` path to a product. It does not render a page. It [permanently redirects ↗](../sw-external-terms.md#http-308-permanent-redirect) to the full product page `/products/<productId>` and keeps the [query string ↗](../sw-external-terms.md#query-string), so parameters such as [`tab`](product-page-tabs.md) still work after the redirect. Design intent (not stated in the spec): a shorter URL that is easier to share.

## Example
A request to `/p/<productId>?tab=discussions` gets back a `308` redirect to `/products/<productId>?tab=discussions`. That page then opens with the [Discussions panel](product-discussions.md).

## Known gaps
- The spec does not say whether the product page's share link uses the `/p/` form or the full `/products/` path.
- The spec does not say what happens when `productId` is unknown. The [not-found page](not-found-state.md) probably shows after the redirect, but no rule says so.
- Not confirmed in the code: the redirect is attributed to `ShortProductLink`, but its file could not be verified (`packages/web/app/p/[productId` was not found).

## Used by
<!-- used-by:start -->
- [not-found-state](not-found-state.md)
- [product-discussions](product-discussions.md)
<!-- used-by:end -->
