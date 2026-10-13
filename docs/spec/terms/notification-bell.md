---
id: notification-bell
title: Notification bell
kind: term
status: draft
aliases: [bell]
defined_for: S28-notifications
rules_hash: 114c311c47d5
---
# Notification bell
## Definition
The notification bell shows a user how many unread inbox items they have. The client reads it from `GET /notifications/unread-count`, which returns the unread count. That count is capped at the unread count ceiling and is read in [constant time ↗](../sw-external-terms.md#constant-time). When a new inbox item is created, the system announces it with the [realtime event](realtime-event.md) `notification` on the owner's [private topic `user:<userId>`](realtime-topic.md), so the bell can update without [polling ↗](../sw-external-terms.md#polling). The bell does not depend on external channels: it updates even when an e-mail, SMS or push delivery is [capped or expired](delivery-capped.md).

## Example
An `order.paid` event creates an inbox item for buyer `u-42` (illustrative id). Topic `user:u-42` receives event `notification`, and the bell goes from 3 to 4 (illustrative values).
A user with 1,500 unread items (illustrative) sees the ceiling of 1,000, not the exact number.

## Known gaps
- The spec does not say what the realtime `notification` event contains. It does not say whether the event includes the new count or whether the client must call `GET /notifications/unread-count` again.
- Not confirmed in the code: that the [`notifications.reconcile-unread`](notifications-reconcile-unread-job.md) job does the unread count repair. The rule only says the count is repaired within a time limit after a crash.
- The spec does not say how the bell should show a count at the ceiling, for example as "1000+".

## Used by
<!-- used-by:start -->
- [delivery-capped](delivery-capped.md)
- [get-unread-count](get-unread-count.md)
- [inbox-item](inbox-item.md)
- [mark-all-read](mark-all-read.md)
- [notifications-controller](notifications-controller.md)
- [notifications-reconcile-unread-job](notifications-reconcile-unread-job.md)
- [outbid-event](outbid-event.md)
- [post-notifications-read](post-notifications-read.md)
- [realtime-event](realtime-event.md)
- [realtime-topic](realtime-topic.md)
- [unread-count-ceiling](unread-count-ceiling.md)
- [unread-count-repair](unread-count-repair.md)
<!-- used-by:end -->
