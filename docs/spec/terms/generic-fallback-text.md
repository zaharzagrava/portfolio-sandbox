---
id: generic-fallback-text
title: Generic fallback text
kind: term
status: draft
aliases: [generic text]
defined_for: S28-notifications
rules_hash: f3aae3964be0
---
# Generic fallback text
## Definition
The generic fallback text is the less specific message a user would see when no dedicated text is used for their case. In the payment-confirmation scenario, the rule is that the [dedicated confirmation text](dedicated-confirmation-text.md) must win over the generic one for a Ukrainian user. The text is chosen when the notification is [rendered](notification-rendering.md), once per recipient, in the [recipient's locale](locale.md). A likely reason is that a vague message would not tell the user that their bank is waiting for an action. That is design intent (not stated in the spec).

## Example
The bank asks a `uk` user to confirm a subscription payment. Expected: the Ukrainian confirmation text. Wrong: the generic payment message.

## Known gaps
- The spec does not say what "generic" means here. It could be a general payment message for the same [event family](notification-family.md), or an English or default-locale version used when a `uk` translation is missing.
- The spec does not say whether every [template](catalog-template.md) has a generic fallback, or what happens when neither text exists. A request that cannot be rendered is [dead-lettered](dead-letter-topic.md) (S28.R-04).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): B-16
- [catalog-template](catalog-template.md)
- [dead-letter-topic](dead-letter-topic.md)
- [dedicated-confirmation-text](dedicated-confirmation-text.md)
- [locale](locale.md)
- [notification-family](notification-family.md)
- [notification-rendering](notification-rendering.md)
- [payment-confirmation-challenge](payment-confirmation-challenge.md)
<!-- used-by:end -->
