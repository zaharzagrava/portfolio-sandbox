---
id: notification-routing
title: Notification routing
kind: term
status: draft
aliases: [route, routing]
defined_for: S28-notifications
rules_hash: f11d7b1c9769
---
# Notification routing
## Definition
Notification routing turns one notification request from an [event consumer](event-consumer.md) into everything each recipient should receive. Recipients are resolved through [identity and tenancy](identity-domain.md). The [router](notification-router.md) renders the message once in each recipient's locale, then creates the inbox item first. For each other [allowed channel](notification-channel.md), it applies the [marketing cap](marketing-cap.md) and [quiet hours](quiet-hours.md), then hands the delivery to [that channel's line](notification-line.md). Each step is [safe to repeat after a crash ↗](../sw-external-terms.md#idempotency), and the dedupe identity stops a second item or delivery.

## Example
An event from the [orders family](notification-family.md) reaches the S28 consumer for a buyer. The router writes the inbox item and publishes `notification` on [`user:<userId>`](realtime-topic.md). It queues the e-mail on [`notify-email`](notify-email-queue.md). The push delivery falls inside the buyer's quiet hours, so it is recorded [`delayed`](delivery-status.md).

## Known gaps
- Not confirmed in the code: which class or service performs routing. The facts name only the controllers and the queues.

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): B-07
- [S28](../capabilities/S28-notifications.md): R-20, R-41
- [catalog-template](catalog-template.md)
- [delivery-timeline-expired](delivery-timeline-expired.md)
- [event-consumer](event-consumer.md)
- [identity-domain](identity-domain.md)
- [known-unmapped-type](known-unmapped-type.md)
- [locale](locale.md)
- [mandatory-type](mandatory-type.md)
- [marketing-cap](marketing-cap.md)
- [maximum-age](maximum-age.md)
- [notification-channel](notification-channel.md)
- [notification-family](notification-family.md)
- [notification-line](notification-line.md)
- [notification-rendering](notification-rendering.md)
- [notification-router](notification-router.md)
- [outbid-event](outbid-event.md)
- [preference-lookup](preference-lookup.md)
- [provider-stand-in](provider-stand-in.md)
- [put-notifications-preferences](put-notifications-preferences.md)
- [quiet-hours](quiet-hours.md)
- [recipient-rule](recipient-rule.md)
- [side-effects](side-effects.md)
<!-- used-by:end -->
