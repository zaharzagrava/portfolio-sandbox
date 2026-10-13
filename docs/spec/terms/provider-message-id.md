---
id: provider-message-id
title: Provider message id
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 5d17e27fbe2d
---
# Provider message id
## Definition
The provider message id is the identifier that an e-mail, SMS or push provider gives to a message it accepts. It is recorded on the [delivery](delivery.md) after the send. Provider callbacks to the [webhook endpoints ↗](../sw-external-terms.md#webhook-event) are matched to their delivery through this id. If a callback arrives before the id is recorded, it is retried for a [bounded time](bounded-retention.md), then [dropped and counted](dropped-late-event.md).

## Example
After a successful send through SES, the delivery stores an id like `0102018f-abcd-…` (illustrative). Later a callback to `POST /notifications/webhooks/ses` reports that id as delivered, and the delivery moves `sent` → `delivered`.

## Known gaps
- The spec does not say where the id is stored, or whether it stays unique across providers after a failover.
- Not confirmed in the code: early callbacks being retried through the [`notifications-callbacks` queue](notifications-callbacks-queue.md).
- The spec does not name the counter for dropped callbacks.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-47
- [bounded-retention](bounded-retention.md)
- [callback-deduplication](callback-deduplication.md)
- [delivery](delivery.md)
- [dropped-late-event](dropped-late-event.md)
- [notifications-callbacks-queue](notifications-callbacks-queue.md)
<!-- used-by:end -->
