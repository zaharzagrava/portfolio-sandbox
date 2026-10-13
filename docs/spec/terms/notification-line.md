---
id: notification-line
title: Notification line
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 1d22eaa67333
---
# Notification line
## Definition
A line is a delivery queue for one channel, worked by its own workers. E-mail, SMS and push each have a transactional line and a marketing line. Marketing lines get less worker capacity. Because the lines are separate, a backlog or a provider outage on one line never delays another. Each catalog entry names the line its type uses. Retries, short [quiet-hour delays](quiet-hours.md) and over-budget returns all go back through the line.

## Example
A marketing e-mail is queued on `notify-marketing-email`. A password-reset e-mail uses `notify-email`. A backlog of a campaign on the marketing line does not slow the reset mail.

## Known gaps
- The spec does not say how the catalog's single line per type maps to the per-channel lines when a type has several default channels. One likely reading is that the catalog value only chooses transactional or marketing.
- The spec does not name the queue technology behind the lines. The entry point for the lines has no proof attached.
- The spec does not give the worker capacity of each line.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-50
- [dead-letter-without-body](dead-letter-without-body.md)
- [delivery](delivery.md)
- [marketing-external-channels](marketing-external-channels.md)
- [marketing-notice](marketing-notice.md)
- [notification-channel](notification-channel.md)
- [notification-delivery](notification-delivery.md)
- [notification-routing](notification-routing.md)
- [notifications-callbacks-queue](notifications-callbacks-queue.md)
- [notifications-wake-delivery-job](notifications-wake-delivery-job.md)
- [provider-failure](provider-failure.md)
- [provider-timeout](provider-timeout.md)
- [quiet-hours](quiet-hours.md)
- [transactional-send](transactional-send.md)
- [transient-failure](transient-failure.md)
- [worker-capacity](worker-capacity.md)
<!-- used-by:end -->
