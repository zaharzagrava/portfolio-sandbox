---
id: recipient-view
title: Recipient view
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 7dcedcd4e2f1
---
# Recipient view
## Definition
The recipient view is the cached form of a user's preferences and settings that routing reads. It includes the preference matrix, [quiet hours](quiet-hours.md), time zone and locale. A preference or settings write [invalidates](invalidate.md) it, and every cached copy also has a maximum lifetime. Together these mean no process should route with values the user has already changed.

## Example
A user turns off push for a category with `PUT /notifications/preferences`. That write invalidates their recipient view. The next event for that user is routed with the new matrix, so no push is created.

## Known gaps
- The spec does not say where the view is cached (per process or in a shared store), or how invalidation reaches other processes. If invalidation is missed, the lifetime is the only bound on stale routing.
- Not confirmed in the code: the exact fields the view holds, or whether it also caches the verified-phone status.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-20
- [invalidate](invalidate.md)
- [notification-settings](notification-settings.md)
- [preference-lookup](preference-lookup.md)
- [put-notifications-preferences](put-notifications-preferences.md)
- [quiet-hours](quiet-hours.md)
- [settings-path](settings-path.md)
<!-- used-by:end -->
