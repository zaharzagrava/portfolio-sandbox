---
id: unread-count
title: Unread count
kind: term
status: draft
aliases: [count]
defined_for: S28-notifications
rules_hash: dc93bc105be0
---
# Unread count
## Definition
The unread count is the number on the bell: how many of the caller's [inbox items](inbox-item.md) are still unread. It is served by [`GET /notifications/unread-count`](get-unread-count.md). It must be read in [constant time ↗](../sw-external-terms.md#constant-time), so it is kept as a stored count rather than counted from the inbox on each request. That count is rebuilt if its store is lost and [repaired](unread-count-repair.md) if it drifts after a crash. [Marking an item read](mark-all-read.md) [decrements it exactly once ↗](../sw-external-terms.md#idempotency), even when the same mark-read happens at the same time.

## Example
A user has 3 unread items. A [`payment` event](notification-type.md) creates a new inbox item, so the bell now reads 4, and the event `notification` is pushed on [`user:<userId>`](user-prefix.md). The user marks that item read twice from two tabs, and the bell goes back to 3, not 2.

## Known gaps
- The spec does not say whether the new count is pushed over [realtime](realtime-event.md) or whether the client must call `GET /notifications/unread-count` again.
- Not confirmed in the code: which store holds the count, and how the rebuild after store loss is triggered.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-39, R-40, B-01, B-10
- [dedupe-identity](dedupe-identity.md)
- [inbox-item](inbox-item.md)
- [mark-all-read](mark-all-read.md)
- [notification-type](notification-type.md)
- [notifications-reconcile-unread-job](notifications-reconcile-unread-job.md)
- [post-notifications-read](post-notifications-read.md)
- [realtime-event](realtime-event.md)
- [side-effects](side-effects.md)
- [unread-count-ceiling](unread-count-ceiling.md)
- [unread-count-repair](unread-count-repair.md)
<!-- used-by:end -->
