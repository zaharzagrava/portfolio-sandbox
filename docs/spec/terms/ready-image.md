---
id: ready-image
title: Ready image
kind: term
status: draft
aliases: [ready, ready images]
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# Ready image
## Definition
A ready image is a product image that the public gallery route is allowed to return. [`GET /products/:productId/gallery`](get-product-gallery.md) returns only ready images and leaves out all other images of the product. So the set of images shown on the product page only includes ready images. The facts do not define what makes an image ready. The word suggests the image has finished some processing step, but that is design intent (not stated in the spec).

## Example
A product has three uploaded images, and one of them is not ready yet. `GET /products/:productId/gallery` returns only the two ready images, in [position order](image-position.md). The page shows two thumbnails. (The image counts are illustrative.)

## Known gaps
- The spec does not say which condition or status marks an image as ready, or what states come before it.
- The spec does not say if the [`media-processing` queue](media-processing-queue.md) is what makes an image ready.
- The spec does not say what the product page shows when a product has no ready images.

## Used by
<!-- used-by:start -->
- [get-product-gallery](get-product-gallery.md)
- [image-position](image-position.md)
- [main-image](main-image.md)
- [media-controller](media-controller.md)
- [media-processing-queue](media-processing-queue.md)
- [product-gallery](product-gallery.md)
<!-- used-by:end -->
