---
id: product-gallery
title: Product gallery
kind: term
status: draft
aliases: [gallery, mediaids]
defined_for: W02-storefront-discovery
rules_hash: 59bbfe827a6c
---
# Product gallery
## Definition
The product gallery is the set of images shown on the product page. A main image is shown with thumbnails, and choosing a thumbnail switches the main image. The images come from a public backend route that returns only [ready images](ready-image.md), in their set display order. The storefront owns the image-processing queue [`media-processing`](media-processing-queue.md), which prepares those images.

## Example
[`GET /products/:productId/gallery`](get-product-gallery.md) (handled by [`MediaController`](media-controller.md) in `packages/backend/libs/domains/media/api/media.controller.ts`) returns the ready images of a product in position order. On the product page, clicking the second thumbnail makes that image the main image.

## Known gaps
- The spec does not say what makes an image "ready", or how an image moves through the `media-processing` queue.
- The spec does not say what the page shows when a product has no ready images.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): B-17
- [image-position](image-position.md)
- [main-image](main-image.md)
- [media-controller](media-controller.md)
- [ready-image](ready-image.md)
<!-- used-by:end -->
