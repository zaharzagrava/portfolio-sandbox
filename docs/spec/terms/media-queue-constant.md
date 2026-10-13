---
id: media-queue-constant
title: MEDIA_QUEUE
kind: term
status: draft
aliases: []
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# MEDIA_QUEUE
## Definition
`MEDIA_QUEUE` is the constant in `media.service.ts` that holds the name of the [`media-processing` queue](media-processing-queue.md). Code uses this constant to refer to the queue instead of writing the name as text. The name is kept in one place so that the code that adds work and the code that reads it cannot use different spellings. That reason is design intent (not stated in the spec).

## Example
```ts
// illustrative: code in media.service.ts names the queue through the constant
queue.add(MEDIA_QUEUE, job);   // not queue.add('media-processing', job)
```

## Known gaps
- Not confirmed in the code: the full path of `media.service.ts`. The facts give only the file name.
- The spec does not say whether `MEDIA_QUEUE` is exported or used outside `media.service.ts`.
- The spec does not say which queue system reads this name, for example the [distributed job scheduler (S49)](../capabilities/S49-job-scheduler.md), the [outbox task queue (S53)](../capabilities/S53-events-projections.md) or something else.

## Used by
<!-- used-by:start -->
- [media-processing-queue](media-processing-queue.md)
<!-- used-by:end -->
