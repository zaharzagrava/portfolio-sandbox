---
id: callback-freshness-window
title: Callback freshness window
kind: term
status: draft
aliases: [freshness window]
defined_for: S28-notifications
rules_hash: b220ee662d45
---
# Callback freshness window
## Definition
The callback freshness window is the time range that an [SNS message ↗](../sw-external-terms.md#sns-message)'s timestamp must fall within for the platform to accept the callback. It applies to callbacks that reach `NotificationWebhooksController` as SNS messages. A message whose timestamp falls outside the window is refused and is not [durably accepted](durable-acceptance.md). The purpose is design intent (not stated in the spec): it stops someone from replaying an old message that is [correctly signed ↗](../sw-external-terms.md#webhook-signature) but was captured earlier.

## Example
A captured SES bounce notification is sent again to `POST /notifications/webhooks/ses` long after it was first issued:
```json
{ "Type": "Notification", "Timestamp": "2026-10-01T08:00:00.000Z" }
```
The current time is well past the window (values are illustrative), so the callback is refused and no [suppression](address-suppression.md) is recorded.

## Known gaps
- The spec does not say how long the window is, or whether it applies to timestamps in the future as well as the past.
- The spec does not say whether Twilio callbacks have a similar freshness check.
- The spec does not say which status code a refused message receives, or whether the refusal is logged or counted.

## Used by
<!-- used-by:start -->
- [address-suppression](address-suppression.md)
- [durable-acceptance](durable-acceptance.md)
- [provider-callback](provider-callback.md)
<!-- used-by:end -->
