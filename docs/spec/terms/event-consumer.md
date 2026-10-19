---
id: event-consumer
title: Event consumer
kind: term
status: draft
aliases: [consumer]
defined_for: outbox-task-queue
rules_hash: aa0f4e0e1beb
---
# Event consumer
## Definition
An event consumer is code that reads events that were published to [Kafka ↗](../sw-external-terms.md#kafka-message) and acts on them. The same event can be published more than once, so a consumer can receive it more than once. Each consumer must declare how it stays safe against duplicates. It must commit its [Kafka offset ↗](../sw-external-terms.md#kafka-offset-commit) only after its effects are done, so a redelivery never loses an event.

## Example
The relay crashes after sending an event but before marking its row as sent. The event arrives again with the same [eventId](event-id.md) (C-05). A consumer that declared `inbox` finds that eventId already recorded and skips the event. Its offset is committed only after the first, real application.

## Known gaps
- The spec does not say how a consumer declares its strategy, for example which API or config field to use.
- The spec does not say which strategy each consumer uses, including S32's search index consumer.
- The spec does not say what a consumer must do when applying an event keeps failing. No retry or [dead-letter ↗](../sw-external-terms.md#dead-letter-queue) rule is given for consumers.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): R-04, R-14, B-02, B-10, B-12
- [S32](../capabilities/S32-product-search.md): R-40
- [S34](../capabilities/S34-recommendations.md): B-11
- [S53](../capabilities/S53-events-projections.md): B-07
- [projection-and-replay](../concepts/projection-and-replay.md): C-03
- [aggregate-id](aggregate-id.md)
- [aggregate-store](aggregate-store.md)
- [aggregate-version](aggregate-version.md)
- [api-layer](api-layer.md)
- [at-least-once-delivery](at-least-once-delivery.md)
- [auctions-source-family](auctions-source-family.md)
- [balance-projector](balance-projector.md)
- [barrel-export](barrel-export.md)
- [billing-events-topic](billing-events-topic.md)
- [billing-source-family](billing-source-family.md)
- [buffered-data](buffered-data.md)
- [cache-invalidator](cache-invalidator.md)
- [category-tracking](category-tracking.md)
- [commit-floor](commit-floor.md)
- [consumer-declaration-error](consumer-declaration-error.md)
- [consumer-deduplication-mode](consumer-deduplication-mode.md)
- [consumer-lag](consumer-lag.md)
- [correction-path](correction-path.md)
- [dead-letter-reason-code](dead-letter-reason-code.md)
- [dead-letter-redrive](dead-letter-redrive.md)
- [dropped-late-event](dropped-late-event.md)
- [entitlement](entitlement.md)
- [entitlements-consumer](entitlements-consumer.md)
- [event-id](event-id.md)
- [event-replay](event-replay.md)
- [event-ts](event-ts.md)
- [fact](fact.md)
- [get-product-by-id](get-product-by-id.md)
- [heavy-hitters](heavy-hitters.md)
- [identity-promotion-consumer](identity-promotion-consumer.md)
- [idle-timeout](idle-timeout.md)
- [infrastructure-layer](infrastructure-layer.md)
- [is-sandbox](is-sandbox.md)
- [known-unmapped-type](known-unmapped-type.md)
- [member-removed-event](member-removed-event.md)
- [merge-cycle](merge-cycle.md)
- [natural-idempotency](natural-idempotency.md)
- [notification-family](notification-family.md)
- [notification-router](notification-router.md)
- [notification-routing](notification-routing.md)
- [notification-version-check](notification-version-check.md)
- [notified-version](notified-version.md)
- [order-baskets-projector](order-baskets-projector.md)
- [order-version](order-version.md)
- [orders-events-consumer](orders-events-consumer.md)
- [outbid-event](outbid-event.md)
- [outbox-relay](outbox-relay.md)
- [payment-event-outcome](payment-event-outcome.md)
- [payment-processor](payment-processor.md)
- [payments-events-consumer](payments-events-consumer.md)
- [post-webhooks-stripe](post-webhooks-stripe.md)
- [read-model](read-model.md)
- [read-your-writes](read-your-writes.md)
- [schema-invalid](schema-invalid.md)
- [search-projector](search-projector.md)
- [shop-status-consumer](shop-status-consumer.md)
- [shutdown-flush](shutdown-flush.md)
- [tenancy-invite-requested-queue](tenancy-invite-requested-queue.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-events](trending-events.md)
- [version-guard](version-guard.md)
- [visitor](visitor.md)
- [webhook-router](webhook-router.md)
<!-- used-by:end -->
