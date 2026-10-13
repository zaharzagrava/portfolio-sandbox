---
id: durable-acceptance
title: Durable acceptance
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 8f7d4377b6ca
---
# Durable acceptance
## Definition
Durable acceptance is the point at which a received provider callback has been stored safely enough that a crash cannot lose it. The [webhook endpoint ↗](../sw-external-terms.md#webhook-event) may answer the provider with [`2xx` ↗](../sw-external-terms.md#http-2xx-success) only after this point. The worker does the real work, such as [suppression](suppression.md) or [timeline updates](delivery-timeline.md), later and separately. If the endpoint fails before durable acceptance, it does not acknowledge the callback, so the provider sends it again ([webhook redelivery](webhook-redelivery.md)). Design intent (not stated in the spec): the endpoint answers the provider quickly without losing events, and slow processing never delays the provider's request.

## Example
Twilio posts an [SMS STOP](sms-stop.md) to `POST /notifications/webhooks/twilio`. The endpoint verifies the request and saves it (illustratively, on the [`notifications-callbacks` queue](notifications-callbacks-queue.md)). Only then does it answer `200`. If saving fails, the endpoint returns an error and Twilio retries.

## Known gaps
- The spec does not say what storage counts as durable. Not confirmed in the code: it may be the `notifications-callbacks` queue.
- The spec does not say which status code the endpoint returns when it cannot durably accept a callback.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-44
- [callback-freshness-window](callback-freshness-window.md)
- [delivery-timeline](delivery-timeline.md)
- [notification-webhooks-controller](notification-webhooks-controller.md)
- [notifications-callbacks-queue](notifications-callbacks-queue.md)
- [provider-callback](provider-callback.md)
- [sms-stop](sms-stop.md)
- [suppression](suppression.md)
- [webhook-redelivery](webhook-redelivery.md)
<!-- used-by:end -->
