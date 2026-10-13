---
id: get-unread-count
title: GET /notifications/unread-count
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# GET /notifications/unread-count
## Definition
`GET /notifications/unread-count` is the endpoint [the notification bell](notification-bell.md) calls to get the caller's unread count. It is served by [`NotificationsController`](notifications-controller.md) and returns only the caller's own count. The count comes from a stored counter, so the endpoint answers in constant time instead of counting [inbox items](inbox-item.md) on each call. The value stops rising at the [unread count ceiling](unread-count-ceiling.md). It is corrected by [unread count repair](unread-count-repair.md) when it drifts after a crash.

## Example
A signed-in user has 1,200 unread inbox items and opens the page. The bell calls the endpoint and shows the capped value. The member name below is illustrative; the spec does not name it:
```json
{ "count": 1000 }
```
The user then calls [`POST /notifications/read`](post-notifications-read.md) for one item. If the user had 4 unread items, the next call returns 3, even if two tabs sent that mark-read at the same moment.

## Known gaps
- The spec does not say what the response body looks like: the member name, or whether it shows that the count hit the ceiling.
- The spec does not say whether the realtime event `notification` on `user:<userId>` carries the new count, or whether the client must call this endpoint again.
- Not confirmed in the code: which store holds the counter, and what the endpoint returns while that store is down or being rebuilt.

## Used by
<!-- used-by:start -->
- [inbox-item](inbox-item.md)
- [notification-bell](notification-bell.md)
- [unread-count-ceiling](unread-count-ceiling.md)
- [unread-count-repair](unread-count-repair.md)
<!-- used-by:end -->
