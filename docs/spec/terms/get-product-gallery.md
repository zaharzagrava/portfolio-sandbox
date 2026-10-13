---
id: get-product-gallery
title: GET /products/:productId/gallery
kind: term
status: draft
aliases: [/products/:productid/gallery, gallery route]
defined_for: W02-storefront-discovery
rules_hash: de57f360d92a
---
# GET /products/:productId/gallery
## Definition
`GET /products/:productId/[gallery](product-gallery.md)` is the public backend route that returns a product's gallery. It returns only [ready images](ready-image.md), sorted by [image position](image-position.md). [`MediaController`](media-controller.md) handles it, and the [W02 storefront capability](../capabilities/W02-storefront-discovery.md) owns it. The product page uses the gallery so that choosing a thumbnail switches the main image.

## Example
```
GET /products/<productId>/gallery
```
The answer lists the product's ready images in position order. When a gallery has several images, the product page shows thumbnails, and clicking one makes it the main image.

## Known gaps
- The spec does not say what the response body looks like (field names, image URLs, sizes).
- The spec does not say what the route answers for an unknown, archived, sandbox or hidden product.
- The spec does not say if the product page calls this route directly or gets the gallery through the [page aggregate](page-aggregate.md), or if the `product:{id}` cache tag applies to it.

## Used by
<!-- used-by:start -->
- [image-position](image-position.md)
- [main-image](main-image.md)
- [media-processing-queue](media-processing-queue.md)
- [page-aggregate](page-aggregate.md)
- [ready-image](ready-image.md)
<!-- used-by:end -->
