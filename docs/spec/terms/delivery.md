---
id: delivery
title: Delivery (notification)
kind: term
status: draft
aliases: [deliveries]
defined_for: S28-notifications
rules_hash: 938d7434473d
---
# Delivery (notification)
## Definition
A delivery is one notification handed to one external channel (e-mail, SMS or push) for one recipient. It is separate from the inbox item, which the router creates first. Its dedupe identity is the [source event id](event-id.md) (or the owner's key), the recipient and the channel. Each delivery travels through its channel's [line](notification-line.md), keeps a timeline of statuses, and is never handed to a provider twice once sent.

## Example
An order event reaches a user who allows e-mail. The router creates the inbox item, then one e-mail delivery goes to `notify-email`. Its timeline might read `queued` → `sent` → `delivered`. If the same event arrives 20 times at once, exactly one delivery still exists.

## Known gaps
- The spec does not say which status transitions are legal or in what order they happen. It only lists the statuses.
- The spec does not say which signal moves a delivery to `delivered`, `bounced` or `complained`. Provider callbacks on the webhooks endpoints are the likely source, but this is not confirmed in the code.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): B-02
- [contact-data](contact-data.md)
- [delivery-line](delivery-line.md)
- [delivery-timeline](delivery-timeline.md)
- [event-id](event-id.md)
- [exported-service](exported-service.md)
- [follower-fan-out](follower-fan-out.md)
- [log-provider](log-provider.md)
- [marketing-email](marketing-email.md)
- [notification-line](notification-line.md)
- [notification-recipient](notification-recipient.md)
- [notified-version](notified-version.md)
- [provider-message-id](provider-message-id.md)
- [provider-stand-in](provider-stand-in.md)
- [render-failure](render-failure.md)
- [resumable-fan-out](resumable-fan-out.md)
- [routing-step](routing-step.md)
- [transient-failure](transient-failure.md)
<!-- used-by:end -->
