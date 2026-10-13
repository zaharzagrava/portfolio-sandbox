---
id: quiet-hours
title: Quiet hours
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 0faa74c6118b
---
# Quiet hours
## Definition
Quiet hours are a daily window a user sets when push and SMS messages must wait. They never drop a message. E-mail and the inbox item are not delayed. The window uses the recipient's own time zone and works across [daylight-saving changes ↗](../sw-external-terms.md#daylight-saving-time) and overnight windows. [A mandatory type](mandatory-notification-type.md) ignores quiet hours.

## Example
A user saves `quietStart: "22:00"` and `quietEnd: "07:00"` with [`PUT /notifications/settings`](notification-settings.md) (illustrative values). An order event arrives at 23:30 in their time zone. The inbox item is created right away. The push delivery is recorded [`delayed`](delivery-status.md) and is held until 07:00. That delay is longer than the [queue delay](queue-delay.md) can hold, so one [`notifications.wake-delivery`](notifications-wake-delivery-job.md) job is scheduled for it.

## Known gaps
- The spec does not say which time zone applies when a user has set quiet hours but no time zone.
- The spec does not say what happens to deliveries already held if the user changes or clears quiet hours during the delay.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-06, R-17, R-21, B-06
- [auctions-source-family](auctions-source-family.md)
- [delivery-timeline](delivery-timeline.md)
- [follower-fan-out](follower-fan-out.md)
- [mandatory-channels](mandatory-channels.md)
- [mandatory-notification-type](mandatory-notification-type.md)
- [mandatory-notification](mandatory-notification.md)
- [mandatory-type](mandatory-type.md)
- [marketing-delivery-cap](marketing-delivery-cap.md)
- [maximum-age](maximum-age.md)
- [notification-channel](notification-channel.md)
- [notification-delivery](notification-delivery.md)
- [notification-line](notification-line.md)
- [notification-maximum-age](notification-maximum-age.md)
- [notification-queue](notification-queue.md)
- [notification-recipient](notification-recipient.md)
- [notification-rendering](notification-rendering.md)
- [notification-router](notification-router.md)
- [notification-routing](notification-routing.md)
- [notification-settings](notification-settings.md)
- [notifications-wake-delivery-job](notifications-wake-delivery-job.md)
- [notify-marketing-push](notify-marketing-push.md)
- [notify-push](notify-push.md)
- [opt-out](opt-out.md)
- [outbid-event](outbid-event.md)
- [preference-lookup](preference-lookup.md)
- [push-notification](push-notification.md)
- [queue-delay](queue-delay.md)
- [recipient-view](recipient-view.md)
- [routing-step](routing-step.md)
- [settings-path](settings-path.md)
- [suppression](suppression.md)
- [wake-instant](wake-instant.md)
<!-- used-by:end -->
