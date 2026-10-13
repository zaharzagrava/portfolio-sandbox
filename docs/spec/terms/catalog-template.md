---
id: catalog-template
title: Catalog template
kind: term
status: draft
aliases: [template catalog]
defined_for: S28-notifications
rules_hash: e48247e31389
---
# Catalog template
## Definition
A catalog template is the message template that the [notification catalog](notification-catalog.md) defines for one [notification type](notification-type.md). [The router](notification-router.md) renders it once per recipient, at [routing time](notification-routing.md), in the recipient's locale. Money in it is formatted from integer [minor units](minor-units.md) and a currency code. Here "catalog" means the notification catalog, not the product catalog. The catalog also decides which [channels](notification-channel.md) are in use, which is why production startup checks provider credentials against it.

## Example
For the password-reset mail, the `PASSWORD_RESET_MAILER` port fills the catalog template with the reset link. A user whose locale is `uk` gets the Ukrainian rendering, and a user whose locale is `en` gets the English one.

## Known gaps
- The spec does not say where the catalog lives or how a new notification type and its template are added.
- The spec does not list the template variables or which types are [mandatory](mandatory-notification.md).
- A request whose template cannot be rendered is [dead-lettered](dead-letter-topic.md). The spec does not say how a missing translation is handled.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-14
- [dead-letter-topic](dead-letter-topic.md)
- [generic-fallback-text](generic-fallback-text.md)
- [locale](locale.md)
- [mandatory-notification](mandatory-notification.md)
- [minor-units](minor-units.md)
- [notification-catalog](notification-catalog.md)
- [notification-channel](notification-channel.md)
- [notification-rendering](notification-rendering.md)
- [notification-router](notification-router.md)
- [notification-routing](notification-routing.md)
- [notification-type](notification-type.md)
- [password-reset-mailer-port](password-reset-mailer-port.md)
- [render-failure](render-failure.md)
- [transactional-mail-module](transactional-mail-module.md)
<!-- used-by:end -->
