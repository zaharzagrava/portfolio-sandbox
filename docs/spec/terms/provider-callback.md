---
id: provider-callback
title: Provider callback
kind: term
status: draft
aliases: [callback]
defined_for: S28-notifications
rules_hash: 235e3cc1f506
---
# Provider callback
## Definition
A provider callback is a message that an e-mail or SMS provider sends back to the platform about a message it was given. It reports what happened to the message, such as a delivery, a bounce, a complaint or an SMS STOP. The platform receives these on the provider webhook endpoints of [`NotificationWebhooksController`](notification-webhooks-controller.md). Each callback must pass the provider's own authentication scheme. Its 2xx acknowledgement comes only after [durable acceptance](durable-acceptance.md), and the worker [deduplicates](callback-deduplication.md) it and applies it once. An [SNS message ↗](../sw-external-terms.md#sns-message) whose timestamp falls outside the [allowed freshness window](callback-freshness-window.md) is refused.

## Example
SES reports a permanent bounce for a password-reset e-mail. The callback arrives at `POST /notifications/webhooks/ses`. After its signature is checked and it is durably accepted, the endpoint returns `2xx`. Later, the worker suppresses the address and records `bounced` on that delivery's timeline.

## Known gaps
- The spec does not say which authentication scheme each provider uses (for example, how SNS signatures or Twilio request signatures are checked).
- The spec does not say how a callback is matched to the delivery it refers to.
- Not confirmed in the code: the queue `notifications-callbacks` appears to be where the worker picks up accepted callbacks, but no rule links the two.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-44
- [bounce](bounce.md)
- [callback-deduplication](callback-deduplication.md)
- [callback-freshness-window](callback-freshness-window.md)
- [complaint](complaint.md)
- [delivery-status](delivery-status.md)
- [durable-acceptance](durable-acceptance.md)
- [log-provider](log-provider.md)
- [mail-provider](mail-provider.md)
- [notification-webhooks-controller](notification-webhooks-controller.md)
- [post-notifications-webhooks-twilio](post-notifications-webhooks-twilio.md)
- [ses-complaint](ses-complaint.md)
- [sms-stop](sms-stop.md)
- [unauthenticated-endpoint](unauthenticated-endpoint.md)
<!-- used-by:end -->
