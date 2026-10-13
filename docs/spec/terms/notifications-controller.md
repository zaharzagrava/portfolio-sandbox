---
id: notifications-controller
title: NotificationsController
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# NotificationsController
## Definition
`NotificationsController` is the HTTP controller of the notifications domain that serves the [signed-in user's own inbox and bell](notification-bell.md). It handles [`GET /notifications`](get-notifications.md), [`GET /notifications/unread-count`](get-unread-count.md) and [`POST /notifications/read`](post-notifications-read.md). It also serves [preferences](notification-settings.md) and settings, and [phone verification](verified-phone.md) sits under the [settings path](settings-path.md) of this controller. Provider webhooks are not handled here: they go to [`NotificationWebhooksController`](notification-webhooks-controller.md). The development mailbox has its own [`DevMailboxController`](get-dev-mailbox.md).

## Example
A signed-in user opens the bell. The front end calls `GET /notifications/unread-count`, then `GET /notifications` to list the items. It then calls `POST /notifications/read` to mark them read. The code lives in `packages/backend/libs/domains/notifications/api/notifications.controller.ts`.

## Known gaps
- The spec does not say whether the device routes (`/notifications/devices`) and the unsubscribe routes ([`/notifications/unsubscribe`](post-notifications-unsubscribe.md)) live on this controller or on another one.
- The spec does not give the exact paths of the phone verification routes. It only says they sit under the settings path of this controller.

## Used by
<!-- used-by:start -->
- [notification-bell](notification-bell.md)
- [notification-settings](notification-settings.md)
- [settings-path](settings-path.md)
- [verified-phone](verified-phone.md)
<!-- used-by:end -->
