---
id: notification-catalog
title: Notification catalog
kind: term
status: draft
aliases: [catalog]
defined_for: S28-notifications
rules_hash: d637fa435338
---
# Notification catalog
## Definition
The notification catalog is the set of [notification types](notification-type.md) the system knows how to send. For each type it holds the template that gets rendered. [Production startup checks the catalog](startup-validation.md): every [channel](notification-channel.md) it uses must have [provider credentials](mail-provider.md). The password-reset e-mail uses its catalog template through the `PASSWORD_RESET_MAILER` port.

## Example
If the catalog has a type that is sent by SMS but production has no SMS provider credentials, the service refuses to start. It does not run and then fail later on the first SMS.

## Known gaps
- The spec does not say where the catalog is defined in the code or which fields an entry has.
- The spec does not say whether the catalog also holds per-type settings such as the category, the mandatory flag or the maximum age.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-37, R-42, R-49
- [catalog-template](catalog-template.md)
- [mail-provider](mail-provider.md)
- [notification-channel](notification-channel.md)
- [notification-type](notification-type.md)
- [recipient-rule](recipient-rule.md)
- [startup-validation](startup-validation.md)
<!-- used-by:end -->
