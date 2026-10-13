---
id: event-ts
title: ts (event timestamp)
kind: term
status: draft
aliases: [ts]
defined_for: S35-trending
rules_hash: e3b0c44298fc
---
# ts (event timestamp)
## Definition
`ts` is the timestamp an analytics event carries for when it happened. The [trending consumer](event-consumer.md) compares it with [`received_at`](received-at.md) and uses the earlier one as the [event time ↗](../sw-external-terms.md#event-time). The event time decides which [trending window](trending-window.md) an event falls into. Taking the earlier value means a sender whose clock runs ahead cannot push the [watermark](watermark.md) forward.

## Example
Here a client clock runs ahead (the values are illustrative):
```json
{ "ts": "2026-10-13T12:10:00Z", "received_at": "2026-10-13T12:00:05Z" }
```
The event time is `12:00:05`, so the event counts in the 12:00–12:01 window. It does not count at 12:10.

## Known gaps
- The spec does not say who sets `ts` (browser, app or collector) or what format it uses.
- The spec does not say what happens to an event that has no `ts`, or has one that cannot be parsed. It may go to the [dead-letter path ↗](../sw-external-terms.md#dead-letter-queue) as "not valid" (S35.B-13), but that is not confirmed.

## Used by
<!-- used-by:start -->
- [event-consumer](event-consumer.md)
- [trending-window](trending-window.md)
- [watermark](watermark.md)
<!-- used-by:end -->
