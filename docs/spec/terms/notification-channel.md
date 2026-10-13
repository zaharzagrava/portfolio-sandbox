---
id: notification-channel
title: Notification channel
kind: term
status: draft
aliases: [channels, line]
defined_for: S28-notifications
rules_hash: 2ba2a0d45ca5
---
# Notification channel
## Definition
A notification channel is one way a notification reaches a person: the in-app inbox, e-mail, SMS or push. Each external channel has its own [delivery line](notification-line.md), a separate [marketing line](notification-line.md) and an ordered [provider chain](provider-chain.md). [Preferences](notification-settings.md) are stored per category and channel. [Quiet hours](quiet-hours.md), [marketing caps](marketing-delivery-cap.md) and [suppression](suppression.md) are also applied per channel.

## Example
The [preference matrix](preference-matrix.md) has one boolean for "marketing × SMS", which defaults to off. Enabling it without a [verified phone](verified-phone.md) answers [`422 phone_not_verified`](phone-not-verified.md). With a verified phone, a marketing SMS goes on [`notify-marketing-sms`](marketing-delivery.md) and is subject to the per-channel cap and to quiet hours.

## Known gaps
- The spec does not say explicitly that the inbox is a channel in the preference matrix. It only names "e-mail, SMS or push" as lines.
- The spec does not say whether the [realtime `notification` event](realtime-event.md) counts as a channel or only as a side effect of the inbox item.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-02, R-15, R-42, R-50
- [catalog-template](catalog-template.md)
- [dedupe-identity](dedupe-identity.md)
- [delivery-bounced](delivery-bounced.md)
- [delivery-capped](delivery-capped.md)
- [delivery-status](delivery-status.md)
- [delivery-timeline](delivery-timeline.md)
- [device-token](device-token.md)
- [explicit-override](explicit-override.md)
- [inbox-item](inbox-item.md)
- [known-unmapped-type](known-unmapped-type.md)
- [mail-provider](mail-provider.md)
- [malformed-queue-message](malformed-queue-message.md)
- [mandatory-channels](mandatory-channels.md)
- [mandatory-notification](mandatory-notification.md)
- [marketing-delivery-cap](marketing-delivery-cap.md)
- [marketing-email](marketing-email.md)
- [notification-catalog](notification-catalog.md)
- [notification-category](notification-category.md)
- [notification-line](notification-line.md)
- [notification-recipient](notification-recipient.md)
- [notification-router](notification-router.md)
- [notification-routing](notification-routing.md)
- [notification-settings](notification-settings.md)
- [notify-email-queue](notify-email-queue.md)
- [notify-marketing-email-queue](notify-marketing-email-queue.md)
- [payment-confirmation-challenge](payment-confirmation-challenge.md)
- [phone-not-verified](phone-not-verified.md)
- [preference-lookup](preference-lookup.md)
- [preference-matrix](preference-matrix.md)
- [provider-chain](provider-chain.md)
- [push-notification](push-notification.md)
- [queue-delay](queue-delay.md)
- [quiet-hours](quiet-hours.md)
- [realtime-event](realtime-event.md)
- [routing-step](routing-step.md)
- [send-budget](send-budget.md)
- [suppression](suppression.md)
- [transactional-delivery](transactional-delivery.md)
- [unsubscribe-link](unsubscribe-link.md)
- [unsubscribe-token](unsubscribe-token.md)
- [verified-phone](verified-phone.md)
- [worker-capacity](worker-capacity.md)
<!-- used-by:end -->
