---
id: event-payload
title: Event payload
kind: term
status: draft
aliases: [payload]
defined_for: realtime-topic-stream
rules_hash: 4d47eaed7b4e
---
# Event payload
## Definition
The event payload is the data a domain attaches to an event when it publishes to a [topic](realtime-topic.md). The stream delivers the payload to every [admitted viewer](connection-admission.md) of that topic. The [hub](realtime-hub.md) must encode the payload so its content can never add an [SSE ↗](../sw-external-terms.md#server-sent-events) field, comment or [frame](stream-frame.md). Without this rule, a stray line break in user-controlled data could forge events (design intent, not stated in the spec).

## Example
[S13](../capabilities/S13-payment-intents.md) publishes a `payment.status` event to `user:{userId}`. Its payload carries the new payment status, for example `{"status":"completed"}` (illustrative shape).

## Known gaps
- The spec does not say how payloads are encoded, for example as JSON on one `data:` line, or how injection is prevented.
- The spec does not say whether payloads have a size limit.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-28
- [S28](../capabilities/S28-notifications.md): B-04
- [S32](../capabilities/S32-product-search.md): R-40
- [S51](../capabilities/S51-realtime-push.md): R-05
- [realtime-topic-stream](../concepts/realtime-topic-stream.md): C-02
- [connection-admission](connection-admission.md)
- [domain-boundary-rules](domain-boundary-rules.md)
- [format-frame](format-frame.md)
- [is-sandbox](is-sandbox.md)
- [member-removed-event](member-removed-event.md)
- [order-cancelled-event](order-cancelled-event.md)
- [order-paid-event](order-paid-event.md)
- [orm-association](orm-association.md)
- [payment-method-token](payment-method-token.md)
- [realtime-hub](realtime-hub.md)
- [realtime-topic](realtime-topic.md)
- [registration-duplicate-attempted-event](registration-duplicate-attempted-event.md)
- [search-document](search-document.md)
- [shop-verification-changed-event](shop-verification-changed-event.md)
- [sse-data-line](sse-data-line.md)
- [stream-frame](stream-frame.md)
- [subscription-plan-changed-event](subscription-plan-changed-event.md)
<!-- used-by:end -->
