---
id: media-processing-queue
title: media-processing queue
kind: term
status: draft
aliases: [image-processing queue, media-processing]
defined_for: W02-storefront-discovery
rules_hash: 0b8de65217a5
---
# media-processing queue
## Definition
`media-processing` is a queue owned by the [W02 storefront capability](../capabilities/W02-storefront-discovery.md). In the code, its name is held in the constant [`MEDIA_QUEUE`](media-queue-constant.md) in `media.service.ts`. W02 also owns the [gallery route](get-product-gallery.md), which sits next to this queue in the media domain. The name suggests that the queue processes product images before they become [ready images](ready-image.md), but that is design intent (not stated in the spec).

## Example
In `media.service.ts`, code that sends work to this queue refers to `MEDIA_QUEUE` and does not hard-code the string `media-processing`.

## Known gaps
- The spec does not say what work the queue carries, who adds work to it, or who consumes it.
- The spec does not say if this queue is built on the [distributed job scheduler (S49)](../capabilities/S49-job-scheduler.md), the [outbox task queue (S53)](../capabilities/S53-events-projections.md) or something else.
- Not confirmed in the code: the full path of `media.service.ts`. The facts give only the file name.

## Used by
<!-- used-by:start -->
- [get-product-gallery](get-product-gallery.md)
- [media-queue-constant](media-queue-constant.md)
- [ready-image](ready-image.md)
<!-- used-by:end -->
