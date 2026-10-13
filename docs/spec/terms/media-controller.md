---
id: media-controller
title: MediaController
kind: term
status: draft
aliases: []
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# MediaController
## Definition
`MediaController` is the backend controller of the [media domain](domain.md). It lives in `packages/backend/libs/domains/media/api/media.controller.ts`. It handles `GET /products/:productId/gallery`, which returns a product's [public gallery](product-gallery.md) of [ready images](ready-image.md) by [position](image-position.md). [The W02 storefront capability](../capabilities/W02-storefront-discovery.md) owns this gallery route.

## Example
A request for `GET /products/:productId/gallery` reaches `MediaController`, which answers with the ready images of that product in position order.

## Known gaps
- The spec does not say if `MediaController` exposes any routes other than the gallery route.
- The spec does not say what guards, rate limit or caching apply to its routes.

## Used by
<!-- used-by:start -->
- [domain](domain.md)
- [image-position](image-position.md)
- [product-gallery](product-gallery.md)
- [ready-image](ready-image.md)
<!-- used-by:end -->
