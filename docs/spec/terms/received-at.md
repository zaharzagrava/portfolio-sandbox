---
id: received-at
title: received_at
kind: term
status: draft
aliases: []
defined_for: S35-trending
rules_hash: e3b0c44298fc
---
# received_at
## Definition
`received_at` is a timestamp field on events in the [`analytics.events` topic](analytics-events-topic.md). Going by its name, it is when the pipeline received the event, but the spec does not say so. The trending consumer uses the earlier of [`ts`](event-ts.md) and `received_at` as the [event time ↗](../sw-external-terms.md#event-time). A client clock set in the future therefore cannot push the [watermark](watermark.md) forward and close [windows](trending-window.md) too early. This happens in `trending-event.ts#normalise`.

## Example
Illustrative values: a `product_view` arrives with `ts` `12:05:00` from a phone whose clock runs fast, and `received_at` `11:00:40`. The event time is `11:00:40`, so the view counts in the 11:00 window.

## Known gaps
- The spec does not say who sets `received_at` (the client or a server-side collector).
- The spec does not say what happens when `received_at` is missing. It may make the message invalid and [dead-lettered ↗](../sw-external-terms.md#dead-letter-queue), but this is not confirmed.

## Used by
<!-- used-by:start -->
- [analytics-events-topic](analytics-events-topic.md)
- [trending-window](trending-window.md)
- [watermark](watermark.md)
<!-- used-by:end -->
