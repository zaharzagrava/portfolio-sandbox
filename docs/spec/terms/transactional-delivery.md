---
id: transactional-delivery
title: Transactional delivery
kind: term
status: draft
aliases: [transactional]
defined_for: S28-notifications
rules_hash: 0e6d724b1630
---
# Transactional delivery
## Definition
A transactional delivery is a delivery that is not marketing. It is usually an e-mail, SMS or push message about something the recipient did or is involved in. The marketing cap never applies to it. It goes through the ordinary e-mail, SMS or push [delivery line](notification-channel.md), not a [marketing line](notification-channel.md). If the [rate limiter](rate-limiter-service.md) is down, it is still sent ([fail open ↗](../sw-external-terms.md#fail-open-fail-closed)).

## Example
An orders event becomes a notification for the buyer. Its e-mail delivery is queued on [`notify-email`](notify-email-queue.md) straight away, even if the buyer already received 2 marketing e-mails in the last 24 hours. The cap counts marketing deliveries only.

## Known gaps
- The spec does not say how a notification type is marked as transactional or marketing. It might be the catalog, the category, or the source event.
- The spec does not say whether every [mandatory type](mandatory-notification-type.md) is transactional, or whether a marketing type can be mandatory.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-28
- [capped-delivery](capped-delivery.md)
- [mandatory-notification-type](mandatory-notification-type.md)
- [marketing-cap](marketing-cap.md)
- [notification-channel](notification-channel.md)
- [rate-limiter-service](rate-limiter-service.md)
<!-- used-by:end -->
