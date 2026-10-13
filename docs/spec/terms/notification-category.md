---
id: notification-category
title: Notification category
kind: term
status: draft
aliases: [category]
defined_for: S28-notifications
rules_hash: e4267d5377bc
---
# Notification category
## Definition
A notification category is a group of [notification types](notification-type.md). Users set their preferences per category, not per individual type. It is one axis of the preference matrix, and [channel](notification-channel.md) is the other. Marketing is one category, and its [external channels](marketing-external-channels.md) default to off. The signed unsubscribe token names one category, and using it switches off e-mail for that category only.

## Example
A [one-click unsubscribe link ↗](../sw-external-terms.md#list-unsubscribe-one-click) in a marketing e-mail carries a token that names the marketing category. [`POST /notifications/unsubscribe?token=…`](post-notifications-unsubscribe.md) turns off only the e-mail cell of that category. Other categories, and SMS or push for marketing, stay as they were.

## Known gaps
- The spec does not list the categories other than marketing.
- The spec does not say how a notification type is mapped to its category, or where that mapping lives.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-15, R-23, R-42, R-46, B-12
- [invalid-unsubscribe-token](invalid-unsubscribe-token.md)
- [mandatory-notification](mandatory-notification.md)
- [marketing-email](marketing-email.md)
- [marketing-external-channels](marketing-external-channels.md)
- [notification-channel](notification-channel.md)
- [notification-type](notification-type.md)
- [phone-not-verified](phone-not-verified.md)
- [phone-verification-code](phone-verification-code.md)
- [post-notifications-unsubscribe](post-notifications-unsubscribe.md)
- [preference-lookup](preference-lookup.md)
- [preference-matrix](preference-matrix.md)
- [unauthenticated-endpoint](unauthenticated-endpoint.md)
- [unsubscribe-link](unsubscribe-link.md)
- [unsubscribe-token](unsubscribe-token.md)
- [verified-phone](verified-phone.md)
<!-- used-by:end -->
