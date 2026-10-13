---
id: image-url
title: imageUrl
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# imageUrl
## Definition
`imageUrl` is the picture link shown on each [search item](search-items.md). Search fills it in from [gallery events](gallery-event.md), not from the catalog's table. When a gallery event is [projected ↗](../sw-external-terms.md#projection), `imageUrl` becomes the thumbnail of the first media id in the event's `mediaIds` list. Because gallery events have their own [version guard](version-guard.md), a late older gallery event cannot overwrite a newer picture.

## Example
A `media.gallery_changed` event for a product arrives with:
```json
{ "mediaIds": ["m1", "m2"] }
```
After projection, that product's search item has `imageUrl` set to the thumbnail of `m1`. `m2` is not used for `imageUrl`.

## Known gaps
- The spec does not say what `imageUrl` becomes when `mediaIds` is empty, or before any gallery event has arrived for a product.
- The spec does not say how the thumbnail URL is built or which service serves it.
- The spec does not say whether `imageUrl` is nullable in [`productSearchResponseSchema`](product-search-response-schema.md), or whether shop search ([`GET /shops/:shopId/products/search`](shop-product-search-route.md)) returns it.

## Used by
<!-- used-by:start -->
- [gallery-event](gallery-event.md)
- [search-items](search-items.md)
- [version-guard](version-guard.md)
<!-- used-by:end -->
