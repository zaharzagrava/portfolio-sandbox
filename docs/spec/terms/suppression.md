---
id: suppression
title: Suppression
kind: term
status: draft
aliases: [suppressed]
defined_for: S28-notifications
rules_hash: 2a347a43fc37
---
# Suppression
## Definition
Suppression permanently stops sending to an address that has proved bad, so it never receives messages again. An address is suppressed after a [permanent provider failure](permanent-error.md), and that delivery is marked [`failed`](delivery-status.md). Every later send to it is recorded [`suppressed`](delivery-suppression.md). Suppression is checked before each send and at the wake instant. Unlike preferences and [quiet hours](quiet-hours.md), it applies even to [mandatory types](mandatory-notification-type.md) and to invitations.

## Example
[SES ↗](../sw-external-terms.md#amazon-ses) reports a permanent failure for an address. The address is suppressed and that delivery is recorded `failed`. Later, a mandatory e-mail to the same address is created. It is not handed to a provider, and its [timeline](delivery-timeline.md) shows `suppressed`. For push, a permanent failure removes the [dead token](dead-push-token.md) instead.

## Known gaps
- The spec does not say whether a [`complained`](complaint.md) callback on `POST /notifications/webhooks/ses` also suppresses the address.
- The spec does not say how a suppressed address can be cleared, for example after a user fixes their mailbox.
- The spec does not say whether suppression is kept per channel (e-mail compared with SMS numbers) or per address only.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-08, R-17, R-33, R-36, R-43
- [dead-push-token](dead-push-token.md)
- [delivery-suppression](delivery-suppression.md)
- [delivery-timeline](delivery-timeline.md)
- [durable-acceptance](durable-acceptance.md)
- [email-line](email-line.md)
- [mandatory-channels](mandatory-channels.md)
- [mandatory-notification-type](mandatory-notification-type.md)
- [mandatory-type](mandatory-type.md)
- [notification-channel](notification-channel.md)
- [notification-delivery](notification-delivery.md)
- [notification-recipient](notification-recipient.md)
- [notifications-wake-delivery-job](notifications-wake-delivery-job.md)
- [notify-email-queue](notify-email-queue.md)
- [notify-marketing-push](notify-marketing-push.md)
- [outbid-event](outbid-event.md)
- [permanent-error](permanent-error.md)
- [preference-matrix](preference-matrix.md)
- [quiet-hours](quiet-hours.md)
- [tenancy-invite-requested-queue](tenancy-invite-requested-queue.md)
- [wake-instant](wake-instant.md)
<!-- used-by:end -->
