---
id: delivery-status
title: Delivery status
kind: term
status: draft
aliases: [failed, sent]
defined_for: S28-notifications
rules_hash: d566f7eb955b
---
# Delivery status
## Definition
The delivery status is a state on a delivery's timeline. The timeline records what happened to one delivery on one [channel](notification-channel.md). The allowed values are `queued`, `delayed`, `sent`, `delivered`, `bounced`, `complained`, `failed`, `suppressed`, `[cap](marketing-delivery-cap.md)ped`, `skipped` and `expired`. Writing the timeline is [best-effort](best-effort-push.md): if a timeline write fails, the send itself does not fail and is not repeated. Secrets never appear in the timeline.

## Example
- A marketing e-mail over the cap: `capped`. It is never queued, but its inbox item stays.
- A send that hits a [permanent error](permanent-error.md): `failed`.
- A whole [provider chain](provider-chain.md) that keeps failing for 5 attempts: `failed` with reason [`exhausted`](exhausted.md).
- An event older than its maximum age: `expired`.

## Known gaps
- The spec does not list which status changes are allowed or which statuses are final. The rule that defines the statuses has no proof.
- The spec does not say what `skipped` covers, for example a channel the user opted out of or a preference that changed before the wake instant.
- The spec does not say how `delivered`, `bounced` and `complained` are set. They most likely come from the [provider callbacks](provider-callback.md) on `POST /notifications/webhooks/ses` and `/twilio`, but the spec does not say so.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-47
- [best-effort-push](best-effort-push.md)
- [delivery-timeline-expired](delivery-timeline-expired.md)
- [delivery-timeline](delivery-timeline.md)
- [failover-timeline-entry](failover-timeline-entry.md)
- [notification-channel](notification-channel.md)
- [permanent-error](permanent-error.md)
- [pre-send-terminal-status](pre-send-terminal-status.md)
- [provider-callback](provider-callback.md)
- [provider-chain](provider-chain.md)
<!-- used-by:end -->
