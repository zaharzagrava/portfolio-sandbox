---
id: main-image
title: Main image
kind: term
status: draft
aliases: []
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# Main image
## Definition
The main image is the large picture at the top of the [product gallery](product-gallery.md) on the product page. It shows one gallery image at a time. When a product has several images, the shopper picks a thumbnail and that image becomes the main image. The images come from the [gallery route](get-product-gallery.md), which returns only [ready images](ready-image.md), sorted by [image position](image-position.md).

## Example
A visitor opens `/products/[productId]` for a product whose gallery has three ready images. Clicking the second thumbnail replaces the main image with the second image. Nothing else on the page changes. (The image count is illustrative.)

## Known gaps
- The spec does not say which image is the main image when the page first opens. Behavior W02.B-17 covers only switching between images.
- The spec does not say what the main image area shows when the gallery has no ready images, or whether thumbnails appear when there is only one image.
- Not confirmed in the code: behavior W02.B-17 has a proof (AS-36) but no `[code]` reference, so the component that holds the main image is not named.

## Used by
<!-- used-by:start -->
- [get-product-gallery](get-product-gallery.md)
- [image-position](image-position.md)
- [product-gallery](product-gallery.md)
- [ready-image](ready-image.md)
<!-- used-by:end -->
