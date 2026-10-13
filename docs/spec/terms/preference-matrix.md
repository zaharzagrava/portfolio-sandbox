---
id: preference-matrix
title: Preference matrix
kind: term
status: draft
aliases: [matrix]
defined_for: S28-notifications
rules_hash: 2fd845870d1c
---
# Preference matrix
## Definition
The preference matrix is a user's stored choice, per [notification category](notification-category.md) and per [channel](notification-channel.md), of whether to receive notifications there. Each cell is a single boolean. A stored cell is an [explicit override](explicit-override.md), and an empty cell falls back to the default. The [router](notification-router.md) reads it to decide which channels a recipient gets, and the worker re-checks it just before each send. [Mandatory types](mandatory-notification-type.md) ignore it, but [suppression](suppression.md) still applies to them.

## Example
`GET /notifications/preferences` returns the full matrix. A user turning off push for one category sends `PUT /notifications/preferences` with that cell set to `false`. Turning on SMS for any category without a verified phone returns `422 phone_not_verified`. The JSON shape is not given in the facts, so any body would be invented.

## Known gaps
- The spec does not say which channels are columns of the matrix, and in particular whether the inbox is one that can be switched off.
- The spec does not give the request or response JSON shape of the matrix.
- The spec does not list the categories that make up the rows.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-15
- [explicit-override](explicit-override.md)
- [inbox-item](inbox-item.md)
- [mandatory-notification-type](mandatory-notification-type.md)
- [notification-category](notification-category.md)
- [notification-channel](notification-channel.md)
- [notification-router](notification-router.md)
- [notify-marketing-email-queue](notify-marketing-email-queue.md)
- [opt-out](opt-out.md)
- [post-notifications-unsubscribe](post-notifications-unsubscribe.md)
- [preference-lookup](preference-lookup.md)
- [put-notifications-preferences](put-notifications-preferences.md)
- [settings-path](settings-path.md)
- [suppression](suppression.md)
- [verified-phone](verified-phone.md)
<!-- used-by:end -->
