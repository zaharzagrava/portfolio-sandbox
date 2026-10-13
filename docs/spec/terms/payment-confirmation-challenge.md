---
id: payment-confirmation-challenge
title: Payment confirmation challenge
kind: term
status: draft
aliases: [bank confirmation]
defined_for: S28-notifications
rules_hash: f3aae3964be0
---
# Payment confirmation challenge
## Definition
A payment confirmation challenge happens when a user's bank asks them to confirm a subscription payment before it goes through. The [billing source family](billing-source-family.md) publishes an event, and this capability turns it into a notification that tells the user to confirm. The notification has its own dedicated text. It is rendered in the recipient's [locale](locale.md), so a user with locale `uk` reads it in Ukrainian.

## Example
A seller with locale `uk` renews a subscription, and their bank asks for confirmation. The seller gets an [inbox item](inbox-item.md) with the confirmation-specific Ukrainian text, not the [generic payment text](generic-fallback-text.md).

## Known gaps
- The spec does not say the name of the billing event, which [channels](notification-channel.md) it uses, or whether it is a [mandatory type](mandatory-type.md).
- The spec does not say whether the message carries a link to complete the confirmation, or what that link looks like.
- The spec does not say what happens if the user never confirms, for example whether there is a reminder.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): B-16
- [billing-source-family](billing-source-family.md)
- [dedicated-confirmation-text](dedicated-confirmation-text.md)
- [generic-fallback-text](generic-fallback-text.md)
- [inbox-item](inbox-item.md)
- [locale](locale.md)
- [mandatory-type](mandatory-type.md)
- [notification-channel](notification-channel.md)
<!-- used-by:end -->
