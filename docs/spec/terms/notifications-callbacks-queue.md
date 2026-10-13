---
id: notifications-callbacks-queue
title: notifications-callbacks queue
kind: term
status: draft
aliases: [notifications-callbacks]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# notifications-callbacks queue
## Definition
`notifications-callbacks` is a queue owned by the notifications capability. The spec lists it as an [entry point](entry-point.md), next to the [delivery lines](notification-line.md) and the [notification jobs](job.md). The spec does not say what the queue carries. From its name, it probably holds provider callback work that arrives at the [SES ↗](../sw-external-terms.md#amazon-ses) and Twilio [webhook endpoints ↗](../sw-external-terms.md#webhook-event), so it can be handled outside the HTTP request. That reading is design intent (not stated in the spec). Treat it as a guess until you have checked the code.

## Example
This is an illustrative flow based on the guess above. It is not taken from the spec.
1. SES reports a bounce to `POST /notifications/webhooks/ses`.
2. The webhook controller puts a message on `notifications-callbacks`.
3. A worker reads the message and writes `bounced` to the delivery timeline for that delivery id.

## Known gaps
- The spec does not say what messages go on this queue, who produces them or who consumes them. The entry is marked `[proof: none]`, so no acceptance scenario covers it.
- The spec does not say if a malformed message on `notifications-callbacks` is [dead-lettered without its body](dead-letter-without-body.md). S28.R-35 only says this for queue messages in the delivery send path.
- The spec does not say how this queue retries, what its worker capacity is, or whether it is isolated from the delivery lines like the per-channel lines are.

## Used by
<!-- used-by:start -->
- [dead-letter-without-body](dead-letter-without-body.md)
- [durable-acceptance](durable-acceptance.md)
- [entry-point](entry-point.md)
- [job](job.md)
- [notification-line](notification-line.md)
- [notification-webhooks-controller](notification-webhooks-controller.md)
- [post-notifications-webhooks-twilio](post-notifications-webhooks-twilio.md)
- [provider-message-id](provider-message-id.md)
- [ses-complaint](ses-complaint.md)
<!-- used-by:end -->
