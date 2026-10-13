---
id: marketing-email
title: Marketing e-mail
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 51fd9c707c01
---
# Marketing e-mail
## Definition
A marketing e-mail is a notification in a [marketing category](notification-category.md) delivered on the [e-mail channel](notification-channel.md). [Marketing external channels](marketing-external-channels.md) are off by default, so the user must [opt in](opt-out.md). It travels on its own line, [`notify-marketing-email`](notify-marketing-email-queue.md), which has lower [worker capacity](worker-capacity.md), so a campaign never delays [transactional mail](transactional-send.md). It obeys [the marketing cap](marketing-cap.md). When the [rate limiter](rate-limiter-service.md) is down, it [fails closed ↗](../sw-external-terms.md#fail-open-fail-closed). Because it is [non-mandatory](mandatory-notification.md), it carries the [signed unsubscribe URL](unsubscribe-link.md) and the [one-click headers ↗](../sw-external-terms.md#list-unsubscribe-one-click).

## Example
A shop posts a marketing notice and it [fans out to followers](follower-fan-out.md). Each opted-in follower gets an [inbox item](inbox-item.md) and a [delivery](delivery.md) on `notify-marketing-email`. That user's third such e-mail within 24 hours is recorded [`capped`](delivery-capped.md). Clicking unsubscribe calls [`POST /notifications/unsubscribe?token=…`](post-notifications-unsubscribe.md), which switches off e-mail for that category.

## Known gaps
- The spec does not list which categories count as marketing.
- The spec does not say how many workers the marketing line has compared with the transactional line ("lower worker capacity" only).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): B-07
- [callback-deduplication](callback-deduplication.md)
- [complaint](complaint.md)
- [delivery](delivery.md)
- [email-line](email-line.md)
- [explicit-override](explicit-override.md)
- [follower-fan-out](follower-fan-out.md)
- [inbox-item](inbox-item.md)
- [mandatory-notification](mandatory-notification.md)
- [marketing-cap](marketing-cap.md)
- [marketing-external-channels](marketing-external-channels.md)
- [notification-category](notification-category.md)
- [notification-channel](notification-channel.md)
- [opt-out](opt-out.md)
- [rate-limiter-service](rate-limiter-service.md)
- [ses-complaint](ses-complaint.md)
- [transactional-send](transactional-send.md)
- [unsubscribe-link](unsubscribe-link.md)
- [worker-capacity](worker-capacity.md)
<!-- used-by:end -->
