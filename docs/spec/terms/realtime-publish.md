---
id: realtime-publish
title: publish
kind: term
status: draft
aliases: []
defined_for: realtime-topic-stream
rules_hash: 7df6744bd6af
---
# publish
## Definition
`publish` is the call a domain uses to send an event to a [topic](realtime-topic.md). [S51](../capabilities/S51-realtime-push.md) defines it and [S13](../capabilities/S13-payment-intents.md) uses it. It is built so that publishing never breaks the domain that calls it. If [the store](realtime-store.md) fails or answers too slowly, `publish` does not throw: it makes one attempt and resolves `{ published: false, id: null }`. The caller then continues its own work as if nothing happened.

## Example
On a payment status change, S13 calls `publish` for [`payment.status`](payment-status.md) on the owner's topic. If the store does not answer within 1 s, the call resolves:
```json
{ "published": false, "id": null }
```
The payment transition still commits, because a push failure must not affect it.

## Known gaps
- The spec does not give the exact signature of `publish` (its arguments) or the success result. Presumably it is `published: true` with an id, but the spec does not state it.
- The spec does not say whether a failed publish is logged, counted or retried later by anything. The rule allows only one attempt inside the call.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-24
- [S51](../capabilities/S51-realtime-push.md): R-19, B-13
- [realtime-publish-limit](realtime-publish-limit.md)
- [realtime-store](realtime-store.md)
- [realtime-topic](realtime-topic.md)
- [replay-page](replay-page.md)
- [sse-data-line](sse-data-line.md)
<!-- used-by:end -->
