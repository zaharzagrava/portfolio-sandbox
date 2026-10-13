---
id: notification-webhooks-controller
title: NotificationWebhooksController
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# NotificationWebhooksController
## Definition
`NotificationWebhooksController` is the [API-layer controller](api-layer.md) in the notifications domain that receives [provider callbacks](provider-callback.md). It has one endpoint for the e-mail provider (SES) and one for the SMS provider (Twilio). Signed-in users do not call these endpoints. Each callback must instead pass its provider's own authentication scheme. The controller returns a 2xx only after [durable acceptance](durable-acceptance.md). A worker later [deduplicates the callback](callback-deduplication.md) and applies its effect once, for example [suppressing an address](address-suppression.md) or updating the [delivery timeline](delivery-timeline.md). Returning 2xx only after durable acceptance is design intent (not stated in the spec): if the platform has not stored the callback, the provider sees a failure and sends it again, so the callback is not lost.

## Example
Twilio reports an [SMS STOP](sms-stop.md) for a number the platform sent a message to. The callback arrives at `POST /notifications/webhooks/twilio`. Once it passes Twilio's authentication check and is durably accepted, the endpoint answers `2xx`. Any change to the recipient happens later in the worker, not in the controller.

## Known gaps
- The spec does not say which authentication scheme each endpoint checks, or which status code a callback that fails the check receives.
- The spec does not say what effect an SMS STOP has on the recipient's preferences or on suppression.
- Not confirmed in the code: accepted callbacks seem to be handed to the [`notifications-callbacks` queue](notifications-callbacks-queue.md) for the worker, but no rule links that queue to this controller.

## Used by
<!-- used-by:start -->
- [address-suppression](address-suppression.md)
- [api-layer](api-layer.md)
- [callback-deduplication](callback-deduplication.md)
- [delivery-timeline](delivery-timeline.md)
- [durable-acceptance](durable-acceptance.md)
- [notifications-callbacks-queue](notifications-callbacks-queue.md)
- [provider-callback](provider-callback.md)
- [sms-stop](sms-stop.md)
<!-- used-by:end -->
