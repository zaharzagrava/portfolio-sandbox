---
id: preference-lookup
title: Preference lookup
kind: term
status: draft
aliases: [preferences]
defined_for: S28-notifications
rules_hash: df7c13f8c79e
---
# Preference lookup
## Definition
A preference lookup reads a recipient's [preference matrix](preference-matrix.md) and [settings](notification-settings.md) to decide which [channels](notification-channel.md) a notification may use. It happens at [routing time](notification-routing.md). It happens again before each send for [non-mandatory types](mandatory-notification-type.md), and at the [wake instant](wake-instant.md). Results come from a [cached recipient view](recipient-view.md) that is cleared when the user writes new preferences or settings. A notification addressed to an e-mail address skips the lookup, because it has no user behind it.

## Example
A user has switched off push for a [marketing category](notification-category.md). When a marketing notice reaches them, the lookup finds push off. No push delivery is queued, and the [inbox item](inbox-item.md) is still created. If the user switches push off while a push is held for [quiet hours](quiet-hours.md), the check at the wake instant sees the new value.

## Known gaps
- The spec does not say which [timeline status](delivery-timeline.md), if any, a delivery gets when the preference check stops it before or at sending.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-08
- [delivery-timeline](delivery-timeline.md)
- [email-line](email-line.md)
- [inbox-item](inbox-item.md)
- [locale](locale.md)
- [mandatory-notification-type](mandatory-notification-type.md)
- [notification-category](notification-category.md)
- [notification-channel](notification-channel.md)
- [notification-routing](notification-routing.md)
- [notification-settings](notification-settings.md)
- [notifications-wake-delivery-job](notifications-wake-delivery-job.md)
- [notify-email-queue](notify-email-queue.md)
- [preference-matrix](preference-matrix.md)
- [quiet-hours](quiet-hours.md)
- [recipient-rule](recipient-rule.md)
- [recipient-view](recipient-view.md)
- [tenancy-invite-requested-queue](tenancy-invite-requested-queue.md)
- [wake-instant](wake-instant.md)
<!-- used-by:end -->
