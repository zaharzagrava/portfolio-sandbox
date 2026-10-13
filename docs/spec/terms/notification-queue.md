---
id: notification-queue
title: Queued notification
kind: term
status: draft
aliases: [queued]
defined_for: S28-notifications
rules_hash: 69f8c741919f
---
# Queued notification
## Definition
A queued notification is a delivery that its channel's line has accepted and recorded with the [timeline status `queued`](delivery-timeline.md). It waits there for a worker to send it. "Queued" does not mean sent: before sending, the worker still checks [suppression](address-suppression.md), the user's current preference and the [maximum age](maximum-age.md). Marketing deliveries go to their own [`notify-marketing-*` lines](notify-marketing-email-queue.md).

## Example
An invitation event (from the [SQS queue ↗](../sw-external-terms.md#sqs-queue) [`tenancy-invite-requested`](tenancy-invite-requested-queue.md)) arrives for an e-mail address. One e-mail containing `<front>/invites/<token>` is queued on `notify-email`. No [inbox item](inbox-item.md) exists, because invitations go to the e-mail line only.

## Known gaps
- The spec does not say whether a delivery held for [quiet hours](quiet-hours.md) is recorded `queued` first or goes straight to `delayed`.
- The spec does not say whether a delivery sent back to its line because a provider was [over budget](send-budget.md) gets a new timeline entry.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): B-05
- [address-suppression](address-suppression.md)
- [capped-delivery](capped-delivery.md)
- [delivery-timeline](delivery-timeline.md)
- [inbox-item](inbox-item.md)
- [maximum-age](maximum-age.md)
- [notify-marketing-email-queue](notify-marketing-email-queue.md)
- [quiet-hours](quiet-hours.md)
- [recipient-rule](recipient-rule.md)
- [send-budget](send-budget.md)
<!-- used-by:end -->
