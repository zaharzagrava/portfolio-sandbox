---
id: locale
title: Locale
kind: term
status: draft
aliases: [locale resolution]
defined_for: S28-notifications
rules_hash: b47da00bcb53
---
# Locale
## Definition
The locale is the recipient's language setting, saved with their [notification settings](notification-settings.md). Each notification is rendered once per recipient, in their locale, when it is [routed](notification-routing.md). The locale picks the [template](catalog-template.md) for the notification type and sets how money is formatted. The lookup tries the exact locale first, then the language alone, then English.

## Example
A user saves their settings with locale `uk`. The next order notification is rendered from the type's `uk` template, and its amount is formatted from [minor units](minor-units.md) in Ukrainian style. A user whose locale is `en` gets the `en` template.

## Known gaps
- The spec does not say how the "exact, then language" lookup applies when settings accept only `en` or `uk`.
- The spec does not say which locale is used for a notification sent to a bare e-mail address, such as an invitation. These skip the [preference lookup](preference-lookup.md).
- The spec does not say whether a later change of locale affects a delivery that was already rendered and is still waiting.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-48
- [catalog-template](catalog-template.md)
- [dedicated-confirmation-text](dedicated-confirmation-text.md)
- [generic-fallback-text](generic-fallback-text.md)
- [minor-units](minor-units.md)
- [notification-rendering](notification-rendering.md)
- [notification-routing](notification-routing.md)
- [notification-settings](notification-settings.md)
- [payment-confirmation-challenge](payment-confirmation-challenge.md)
- [preference-lookup](preference-lookup.md)
<!-- used-by:end -->
