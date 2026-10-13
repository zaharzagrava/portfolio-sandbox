---
id: mandatory-notification-type
title: Mandatory notification type
kind: term
status: draft
aliases: [non-mandatory]
defined_for: S28-notifications
rules_hash: 5f4528299db6
---
# Mandatory notification type
## Definition
A mandatory notification type is one that must reach the user whatever their preferences say. It ignores category and channel opt-outs and quiet hours, but suppression still applies. The worker skips the preference check before sending it. Its e-mails carry no unsubscribe URL or [one-click headers ↗](../sw-external-terms.md#list-unsubscribe-one-click). The preferences and settings answers list `mandatoryChannels` so the client can show which channels cannot be turned off.

## Example
Say a mandatory security notice is sent at 23:30 inside a user's quiet hours (illustrative). The SMS goes out immediately rather than being delayed. If the user's e-mail address is suppressed after a bounce, the e-mail is still recorded `suppressed` and not sent.

## Known gaps
- The spec does not list which notification types are mandatory, or say whether the password-reset mail is one of them.
- The spec does not say how `mandatoryChannels` is shaped: per category or one global list.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-24, R-36
- [billing-source-family](billing-source-family.md)
- [bounce](bounce.md)
- [complaint](complaint.md)
- [delivery-suppression](delivery-suppression.md)
- [mail-scanner](mail-scanner.md)
- [mandatory-channels](mandatory-channels.md)
- [mandatory-notification](mandatory-notification.md)
- [marketing-cap](marketing-cap.md)
- [preference-lookup](preference-lookup.md)
- [preference-matrix](preference-matrix.md)
- [quiet-hours](quiet-hours.md)
- [sms-stop](sms-stop.md)
- [suppression](suppression.md)
- [transactional-delivery](transactional-delivery.md)
- [unsubscribe-link](unsubscribe-link.md)
<!-- used-by:end -->
