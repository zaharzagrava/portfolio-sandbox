---
id: gallery-event
title: Gallery event
kind: term
status: draft
aliases: [mediaids]
defined_for: S32-product-search
rules_hash: 224ab59ec2de
---
# Gallery event
## Definition
A gallery event is the `media.gallery_changed` message that search consumes to keep a product's picture current. It carries the product's ordered `mediaIds`. The [projection ↗](../sw-external-terms.md#projection) sets the item's [`imageUrl`](image-url.md) to the thumbnail of the first media id. Like [the other sources](job-source.md), it is applied under its own [version guard](version-guard.md).

## Example
```json
{ "mediaIds": ["m1", "m2"] }
```
After projection, `imageUrl` is the thumbnail URL of `m1`.

## Known gaps
- The spec does not say what `imageUrl` becomes when `mediaIds` is empty.
- The spec does not say how the thumbnail URL is built.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): B-13
- [image-url](image-url.md)
- [job-source](job-source.md)
- [version-guard](version-guard.md)
<!-- used-by:end -->
