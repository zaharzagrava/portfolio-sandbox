---
id: sms-stop
title: SMS STOP
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 6303d8d20d92
---
# SMS STOP
## Definition
An SMS STOP is a [provider callback](provider-callback.md) saying that the recipient replied STOP to one of the platform's text messages. This opts the recipient out of SMS from the sender. The platform then [suppresses](address-suppression.md) that phone number, so no further SMS goes to it. Because [mandatory types](mandatory-notification-type.md) never bypass suppression, the number stops receiving mandatory SMS as well.

## Example
A buyer replies "STOP" to an SMS sent on [`notify-sms`](notify-sms-queue.md). Twilio posts the event to [`POST /notifications/webhooks/twilio`](post-notifications-webhooks-twilio.md). The buyer's phone number is suppressed, and later SMS deliveries to it are recorded as [`suppressed`](delivery-suppression.md).

## Known gaps
- The spec does not say whether STOP also changes the user's [SMS preferences](notification-settings.md). It only describes that for complaints and marketing e-mail.
- The spec does not say whether a later START reply, or verifying the phone again, lifts the suppression.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-46
- [address-suppression](address-suppression.md)
- [durable-acceptance](durable-acceptance.md)
- [mandatory-notification-type](mandatory-notification-type.md)
- [notification-settings](notification-settings.md)
- [notification-webhooks-controller](notification-webhooks-controller.md)
- [post-notifications-webhooks-twilio](post-notifications-webhooks-twilio.md)
- [provider-callback](provider-callback.md)
<!-- used-by:end -->
