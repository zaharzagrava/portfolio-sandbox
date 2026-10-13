---
id: dedicated-confirmation-text
title: Dedicated confirmation text
kind: term
status: draft
aliases: [dedicated text, ukrainian confirmation text]
defined_for: S28-notifications
rules_hash: 28cb0bb04539
---
# Dedicated confirmation text
## Definition
The dedicated confirmation text is the message written for one case: a payment that is waiting for the user to confirm it with their bank. When this text exists for the recipient's [locale](locale.md), it must be used instead of the generic fallback text. It is chosen during [notification rendering](notification-rendering.md), once per recipient, in the recipient's locale. Design intent (not stated in the spec): a generic payment message would not tell the user that their bank is waiting for them to act.

## Example
A [payment confirmation challenge](payment-confirmation-challenge.md) is raised for a user whose locale is `uk`.
Expected: the Ukrainian confirmation text, which asks them to confirm the payment with their bank.
Wrong: the generic payment message, even if it is also in Ukrainian.

## Known gaps
- The spec does not say which template or catalog entry holds this text, or which event type or notification type selects it.
- The spec does not say what happens when the dedicated text exists in `en` but not in `uk`. It could fall back to the generic `uk` text or to the dedicated `en` text.
- The spec does not say what happens when neither text can be produced. A request that cannot be rendered is [dead-lettered](dead-letter-topic.md) (S28.R-04).

## Used by
<!-- used-by:start -->
- [dead-letter-topic](dead-letter-topic.md)
- [generic-fallback-text](generic-fallback-text.md)
- [locale](locale.md)
- [notification-rendering](notification-rendering.md)
- [payment-confirmation-challenge](payment-confirmation-challenge.md)
<!-- used-by:end -->
