---
id: marketing-external-channels
title: Marketing external channels
kind: term
status: draft
aliases: [external channels]
defined_for: S28-notifications
rules_hash: 2b6b40dc1e45
---
# Marketing external channels
## Definition
Marketing external channels are the e-mail, SMS and push channels of the marketing category. "External" means delivered through a provider, as opposed to the inbox item. In the preference matrix they default to off, so a user must opt in to them. Design intent (not stated in the spec): opt-in consent for promotional messages. When they are enabled, these deliveries still go through the [marketing cap](marketing-cap.md) and the [separate marketing lines](notification-line.md).

## Example
A new user who has never changed preferences receives a marketing notice. The [router](notification-router.md) still creates the inbox item. It does not queue anything on [`notify-marketing-email`](notify-marketing-email-queue.md), `notify-marketing-sms` or `notify-marketing-push`, because those cells default to off.

## Known gaps
- The spec does not say whether the marketing inbox item can itself be switched off.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-15
- [dead-letter-without-body](dead-letter-without-body.md)
- [explicit-override](explicit-override.md)
- [marketing-cap](marketing-cap.md)
- [marketing-email](marketing-email.md)
- [notification-category](notification-category.md)
- [notification-line](notification-line.md)
- [notification-router](notification-router.md)
- [opt-out](opt-out.md)
- [push-notification](push-notification.md)
<!-- used-by:end -->
