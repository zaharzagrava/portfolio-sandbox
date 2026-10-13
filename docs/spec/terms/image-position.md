---
id: image-position
title: Image position
kind: term
status: draft
aliases: [ordered by position, position order]
defined_for: W02-storefront-discovery
rules_hash: a38153770515
---
# Image position
## Definition
The image position is the order of an image inside a product's [gallery](product-gallery.md). [`GET /products/:productId/gallery`](get-product-gallery.md) returns the [ready images](ready-image.md) sorted by this position. The product page then shows the thumbnails in that order. This is not the `position` in the [search click record](click-log.md), which is the place of a result in the search list.

## Example
A product has ready images at positions 0, 1 and 2. The gallery route returns them in that order, so the image at position 0 comes first in the thumbnail strip. (The position values are illustrative.)

## Known gaps
- The spec does not say if positions start at 0 or 1, or if they must be unique and gap-free.
- The spec does not say who sets or changes an image's position.
- The spec does not say if the first image by position is the [main image](main-image.md) when the page opens.

## Used by
<!-- used-by:start -->
- [click-log](click-log.md)
- [get-product-gallery](get-product-gallery.md)
- [main-image](main-image.md)
- [media-controller](media-controller.md)
- [product-gallery](product-gallery.md)
- [ready-image](ready-image.md)
<!-- used-by:end -->
