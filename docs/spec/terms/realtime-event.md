---
id: realtime-event
title: Realtime event
kind: term
status: draft
aliases: [event]
defined_for: S51-realtime-push
rules_hash: 998c4930b86d
---
# Realtime event
## Definition
A realtime event is one message that a domain sends to a [realtime topic](realtime-topic.md) with [`publish(topic, type, data, options?)`](realtime-publish.md). It has a topic, a type and a data payload. A [replayable event](replayable-event.md) is stored in the [replay buffer](replay-buffer.md) and gets a [cursor position](replay-cursor.md). An event published with [`replay: false`](replay-false.md) is only delivered live. A client receives only the events of the topics it subscribed to, each written as one stream frame.

## Example
```ts
// illustrative topic id and payload
await publish("user:<A>", "price", { price: 3 });
// → { published: true, id: "<id>" }, or { published: false, id: null } if the store is down
```

## Known gaps
- The spec does not say how event types or payloads are validated at publish time. The related scenarios are listed, but no rule states them.
- The spec does not list the members of `options` other than `replay`.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): B-01
- [S51](../capabilities/S51-realtime-push.md): B-08
- [comment-moderation](comment-moderation.md)
- [done-marker](done-marker.md)
- [format-frame](format-frame.md)
- [inbox-item](inbox-item.md)
- [notification-bell](notification-bell.md)
- [notification-channel](notification-channel.md)
- [payment-method-token](payment-method-token.md)
- [post-notifications-read](post-notifications-read.md)
- [realtime-topic](realtime-topic.md)
- [render-failure](render-failure.md)
- [replay-buffer](replay-buffer.md)
- [replay-cursor](replay-cursor.md)
- [replayable-event](replayable-event.md)
- [security-events](security-events.md)
- [side-effects](side-effects.md)
- [sse-data-line](sse-data-line.md)
- [unread-count](unread-count.md)
<!-- used-by:end -->
