---
id: post-notifications-webhooks-twilio
title: POST /notifications/webhooks/twilio
kind: term
status: draft
aliases: [/notifications/webhooks/twilio]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# POST /notifications/webhooks/twilio
## Definition
`POST /notifications/webhooks/twilio` is the endpoint where Twilio, the SMS provider, reports back to the platform. It is a [provider callback](provider-callback.md) that [`NotificationWebhooksController`](notification-webhooks-controller.md) handles. The platform uses these reports to update the [delivery timeline](delivery-timeline.md) of SMS deliveries. It also uses them to [suppress phone numbers](address-suppression.md), for example after an [SMS STOP](sms-stop.md) reply. It is an [unauthenticated endpoint](unauthenticated-endpoint.md), because Twilio calls it and not a signed-in user.

## Example
A buyer replies "STOP" to an order text sent through [`notify-sms`](notify-sms-queue.md). Twilio calls `POST /notifications/webhooks/twilio` to report it. The buyer's number is suppressed, so later SMS deliveries to that number are recorded as [`suppressed`](delivery-suppression.md) and never reach Twilio.

## Known gaps
- The spec does not say how the platform checks that a call really comes from Twilio, such as [signature checking ↗](../sw-external-terms.md#webhook-signature) or a shared secret.
- The spec does not say whether the endpoint handles callbacks itself or passes them to the [`notifications-callbacks` queue](notifications-callbacks-queue.md). Splitting reception from processing that way may be design intent (not stated in the spec).
- The spec does not say which Twilio callback kinds map to which delivery statuses, other than that STOP and permanent failures lead to suppression.

## Used by
<!-- used-by:start -->
- [address-suppression](address-suppression.md)
- [delivery-timeline](delivery-timeline.md)
- [notifications-callbacks-queue](notifications-callbacks-queue.md)
- [provider-callback](provider-callback.md)
- [sms-stop](sms-stop.md)
- [unauthenticated-endpoint](unauthenticated-endpoint.md)
<!-- used-by:end -->
