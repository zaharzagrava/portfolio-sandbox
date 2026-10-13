---
id: mandatory-type
title: Mandatory type
kind: term
status: draft
aliases: [mandatory]
defined_for: S28-notifications
rules_hash: 468a3ba0f8b7
---
# Mandatory type
## Definition
A mandatory type is a notification type that the user cannot switch off. [Routing](notification-routing.md) ignores the user's category and channel opt-outs and [quiet hours](quiet-hours.md) for it. [Suppression](suppression.md) still applies, so a suppressed address gets nothing. Its e-mails carry no unsubscribe URL and no [one-click headers ↗](../sw-external-terms.md#list-unsubscribe-one-click). The worker skips the [current-preference check](notification-version-check.md) for it before a send.

## Example
A password-reset mail sent through the `PASSWORD_RESET_MAILER` port is probably mandatory, but the spec does not confirm this. If it is, the mail goes out even when the user has turned off e-mail for that category, and it carries no unsubscribe link. It is still not sent if the address is suppressed.

## Known gaps
- The spec does not say which notification types are mandatory or where that list is kept.
- The spec does not say how [`mandatoryChannels`](mandatory-channels.md) is worked out: per type, per category, or for the whole user.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-17
- [address-suppression](address-suppression.md)
- [notification-routing](notification-routing.md)
- [notification-type](notification-type.md)
- [notification-version-check](notification-version-check.md)
- [opt-out](opt-out.md)
- [outbid-event](outbid-event.md)
- [payment-confirmation-challenge](payment-confirmation-challenge.md)
- [post-notifications-unsubscribe](post-notifications-unsubscribe.md)
- [quiet-hours](quiet-hours.md)
- [suppression](suppression.md)
- [unsubscribe-token](unsubscribe-token.md)
<!-- used-by:end -->
