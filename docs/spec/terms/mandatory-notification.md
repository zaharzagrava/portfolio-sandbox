---
id: mandatory-notification
title: Mandatory notification
kind: term
status: draft
aliases: [mandatory, mandatory flag]
defined_for: S28-notifications
rules_hash: 2d3d8346d73c
---
# Mandatory notification
## Definition
A mandatory notification is one whose [type is marked mandatory in the catalog](mandatory-notification-type.md). It is still delivered when the user has opted out of its [category](notification-category.md) or [channel](notification-channel.md), and [quiet hours](quiet-hours.md) do not delay it. [Suppression](address-suppression.md) does block it: a suppressed address or number receives nothing, mandatory or not. Its e-mails carry no unsubscribe URL or one-click headers. The preference endpoints report the affected channels in `mandatoryChannels`.

## Example
A user has switched off e-mail for a category and set quiet hours. A mandatory e-mail of that category is still sent right away, with no unsubscribe link. If the user's e-mail address is suppressed, the delivery's timeline records `suppressed` and nothing is sent.

## Known gaps
- The spec does not say which notification types are mandatory. The password-reset mail is not stated to be one.
- The spec does not say whether the marketing cap can apply to a mandatory type. The cap only exempts "transactional" deliveries, and the spec does not say whether mandatory types count as transactional.
- The spec does not say exactly what `mandatoryChannels` contains: channels per category, or per type.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-43, R-50
- [address-suppression](address-suppression.md)
- [catalog-template](catalog-template.md)
- [mandatory-notification-type](mandatory-notification-type.md)
- [marketing-email](marketing-email.md)
- [notification-category](notification-category.md)
- [notification-channel](notification-channel.md)
- [quiet-hours](quiet-hours.md)
<!-- used-by:end -->
