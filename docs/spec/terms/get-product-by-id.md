---
id: get-product-by-id
title: GET /products/:productId
kind: term
status: draft
aliases: [/products/p2]
defined_for: J02-seller-to-first-sale
rules_hash: e3b0c44298fc
---
# GET /products/:productId
## Definition
`GET /products/:productId` returns one product by its id. It reads the product directly and does not depend on the [search projection](search-projector.md). A new product is therefore readable here before search shows it. The [seller journey](main-journeys.md) uses this route to show that a paused [search consumer](event-consumer.md) delays search but not the product itself.

## Example
The search consumer is paused and the owner creates product `P2`. `GET /products/P2` answers `200`, but search omits `P2` until the consumer resumes.

## [Known gaps](known-gaps.md)
- The spec does not give the response body of this route.
- The spec does not say what this route returns for [archived products](product-archive.md), or for products of a [suspended shop](shop-status.md). J02.R-13 only covers hiding them in search.
- The facts list no routes for this capability, so the page that owns this route is not named here.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
