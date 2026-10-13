---
id: unread-count-ceiling
title: Unread count ceiling
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 44df9d4f3d4f
---
# Unread count ceiling
## Definition
The [unread count](unread-count.md) ceiling is the upper bound on the unread count. When a user has more unread items than the ceiling, the count reports the ceiling instead of the true number. One likely reason is to keep the stored count and the [bell display](notification-bell.md) bounded, but that is design intent (not stated in the spec).

## Example
A user has 1,200 unread inbox items (illustrative). [`GET /notifications/unread-count`](get-unread-count.md) reports 1,000, the ceiling.

## Known gaps
- The spec does not say what happens when items are read while the true number is above the ceiling. For example, after reading 300 of 1,200 items, the count should be 900, but a capped counter that simply decrements would show 700.
- The spec does not say how the client should show a count at the ceiling (for example "999+").

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-39
- [get-unread-count](get-unread-count.md)
- [notification-bell](notification-bell.md)
- [unread-count](unread-count.md)
<!-- used-by:end -->
