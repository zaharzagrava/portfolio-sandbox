---
id: realtime-topic
title: Realtime topic
kind: term
status: draft
aliases: [topic]
defined_for: realtime-topic-stream
rules_hash: f2b40a3c0927
---
# Realtime topic
## Definition
A realtime topic is a named channel that a [domain](orders-domain.md) publishes events to. When a browser opens its live event connection, it names one or more topics and receives only events from those topics. Each topic has its own rule for who may receive it, and the [hub](realtime-hub.md) checks that rule when a connection opens. One instance holds one shared subscription per topic, however many people are watching it.

## Example
S13 publishes a `payment.status` event to the owner's topic `user:{userId}` each time a payment's status changes. W03 reads that same topic to update the notification bell and show the payment result.

## Known gaps
- The spec does not say how topic names are formed in general. `user:{userId}` is the only pattern stated.
- The spec does not say which topics exist or what each one's access rule is. The topic registry is described only on the S51 page.
- The spec does not say how S03 uses topics. Its page lists the concept but never links it.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-24
- [S51](../capabilities/S51-realtime-push.md): R-02, R-13, R-21, R-28, B-05, B-16, B-19
- [realtime-topic-stream](../concepts/realtime-topic-stream.md): C-01, C-02
- [best-effort-push](best-effort-push.md)
- [connection-admission](connection-admission.md)
- [event-payload](event-payload.md)
- [live-shop](live-shop.md)
- [membership-query-service](membership-query-service.md)
- [orders-domain](orders-domain.md)
- [payment-status-event](payment-status-event.md)
- [realtime-backplane](realtime-backplane.md)
- [realtime-event](realtime-event.md)
- [realtime-hub](realtime-hub.md)
- [realtime-listener](realtime-listener.md)
- [realtime-publish-limit](realtime-publish-limit.md)
- [realtime-publish](realtime-publish.md)
- [realtime-store](realtime-store.md)
- [realtime-topic-access-rule](realtime-topic-access-rule.md)
- [realtime-unavailable](realtime-unavailable.md)
- [ref-counted-fan-out](ref-counted-fan-out.md)
- [replay-buffer](replay-buffer.md)
- [replay-cursor](replay-cursor.md)
- [replay-page](replay-page.md)
- [replayable-event](replayable-event.md)
- [shop-member](shop-member.md)
- [slow-consumer-close](slow-consumer-close.md)
- [stream-connection](stream-connection.md)
- [stream-frame](stream-frame.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
- [too-many-connections](too-many-connections.md)
- [topic-registry-frozen](topic-registry-frozen.md)
- [topic-registry](topic-registry.md)
- [unusable-cursor-entry](unusable-cursor-entry.md)
- [viewer](viewer.md)
<!-- used-by:end -->
