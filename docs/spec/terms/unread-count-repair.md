---
id: unread-count-repair
title: Unread count repair
kind: term
status: draft
aliases: [repaired]
defined_for: S28-notifications
rules_hash: b84c0aab01d1
---
# Unread count repair
## Definition
Unread count repair fixes the unread count when it disagrees with the inbox after a crash. The case it covers: an [inbox item](inbox-item.md) is written, but the process dies before the count is updated, or the other way round. The rule requires the count to be correct again within the repair window. This is separate from rebuilding the count after its whole store is lost.

## Example
[The router](notification-router.md) writes a new inbox item for a user and crashes before incrementing the count. [The bell](notification-bell.md) shows 4 while the user has 5 unread items. Within 5 minutes the repair corrects the bell to 5.

## Known gaps
- Not confirmed in the code: that the job [`notifications.reconcile-unread`](notifications-reconcile-unread-job.md) performs this repair. The name suggests it, but its entry point has no proof.
- The spec's wording "between store and count" does not name the two writes exactly. This page reads them as the inbox item write and the count update.
- The spec does not say how often the repair runs, or whether it checks every user or only those affected by the crash.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-39
- [get-unread-count](get-unread-count.md)
- [inbox-item](inbox-item.md)
- [notification-bell](notification-bell.md)
- [notification-router](notification-router.md)
- [unread-count](unread-count.md)
<!-- used-by:end -->
