---
id: push-notification
title: Push notification
kind: term
status: draft
aliases: [push]
defined_for: S28-notifications
rules_hash: ebf2dff1dc9a
---
# Push notification
## Definition
A push notification is a message sent to a user's registered devices through the [push channel](notification-channel.md). It is one of the three [external channels](marketing-external-channels.md), next to e-mail and SMS. [Transactional push](transactional-send.md) goes through the [`notify-push` line](notify-push.md) and marketing push through [`notify-marketing-push`](notify-marketing-push.md), so a backlog on one line never delays the other. Push is one of the two channels that [quiet hours](quiet-hours.md) can delay; SMS is the other. A permanent provider failure removes the dead device token.

## Example
A device registers with `POST /notifications/devices`. Later the user is [outbid](outbid-event.md) during quiet hours. The [inbox item](inbox-item.md) is created at once, and the push waits on the `notify-push` line until the window ends. A delay up to the [queue-delay limit](queue-delay.md) uses the queue delay. A longer delay uses one [`notifications.wake-delivery` job](notifications-wake-delivery-job.md).

## Known gaps
- The spec does not name the push provider or providers in the [push chain](provider-chain.md).
- The spec does not say what payload reaches the device (title, body, deep link).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): B-06
- [device-ownership](device-ownership.md)
- [device-registration](device-registration.md)
- [inbox-item](inbox-item.md)
- [marketing-external-channels](marketing-external-channels.md)
- [notification-channel](notification-channel.md)
- [notifications-wake-delivery-job](notifications-wake-delivery-job.md)
- [notify-push](notify-push.md)
- [outbid-event](outbid-event.md)
- [provider-chain](provider-chain.md)
- [queue-delay](queue-delay.md)
- [quiet-hours](quiet-hours.md)
- [transactional-send](transactional-send.md)
<!-- used-by:end -->
