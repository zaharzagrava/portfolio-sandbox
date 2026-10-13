---
id: notification-router
title: Notification router
kind: term
status: draft
aliases: [router]
defined_for: S28-notifications
rules_hash: a0c1c4762260
---
# Notification router
## Definition
The notification router turns each notification request into per-recipient work after the [event consumer](event-consumer.md) has mapped it. For each recipient it creates the inbox item first. Then, for each other allowed channel, it applies the [marketing cap](marketing-cap.md) and [quiet hours](quiet-hours.md) and hands the delivery to that channel's [line](notification-channel.md). If a step fails, the earlier steps stay in place and the event can be retried. Every step is safe to repeat after a crash, so a retry ends in the same state as one uninterrupted run.

## Example
An `order.paid` event reaches the orders consumer, which maps it to a notification for the buyer. The router renders the notification in the buyer's locale and creates the inbox item. Next it checks quiet hours for push and hands an e-mail delivery to the `notify-email` line. Suppose the push hand-off crashes. The retry finds the inbox item and the e-mail delivery already there, through their dedupe identity, and creates only the missing push delivery.

## Known gaps
- Not confirmed in the code: which class or module implements the router. The facts name only the controllers and the delivery lines.
- The spec does not say whether channels are handed off one after another or in parallel. It also does not say what order channels are processed in after the inbox item.
- The spec does not say why the inbox item comes first. A likely reason is that the user still sees the fact if every external channel fails, but that is design intent (not stated in the spec).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-10
- [catalog-template](catalog-template.md)
- [done-marker](done-marker.md)
- [event-consumer](event-consumer.md)
- [in-memory-mailbox](in-memory-mailbox.md)
- [inbox-item](inbox-item.md)
- [marketing-cap](marketing-cap.md)
- [marketing-external-channels](marketing-external-channels.md)
- [notification-channel](notification-channel.md)
- [notification-recipient](notification-recipient.md)
- [notification-routing](notification-routing.md)
- [notification-type](notification-type.md)
- [notify-email-queue](notify-email-queue.md)
- [notify-marketing-email-queue](notify-marketing-email-queue.md)
- [preference-matrix](preference-matrix.md)
- [queue-delay](queue-delay.md)
- [queue-refusal](queue-refusal.md)
- [quiet-hours](quiet-hours.md)
- [routing-step](routing-step.md)
- [unread-count-repair](unread-count-repair.md)
<!-- used-by:end -->
