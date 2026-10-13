---
id: post-notifications-read
title: POST /notifications/read
kind: term
status: draft
aliases: [/notifications/read]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# POST /notifications/read
## Definition
`POST /notifications/read` marks the caller's own [inbox items](inbox-item.md) as read and lowers the [unread count](unread-count.md). It is [idempotent ↗](../sw-external-terms.md#idempotency): marking an item that is already read changes nothing. It is [owner-scoped](caller-scoping.md), so a caller cannot mark another user's items. When several calls for the same item run at the same time, the count goes down only once for that item. The [mark-all form](mark-all-read.md) uses a [watermark](watermark.md), so items that arrive after the watermark stay unread.

## Example
Buyer `u-42` sends two `POST /notifications/read` calls for the same item at the same moment (illustrative). The unread count drops from 4 to 3, not to 2.
`u-42` marks all as read while a new item is being created. The new item is after the watermark, so it stays unread and the count is 1 (illustrative values).

## Known gaps
- The spec does not give the request body or response shape. It does not say how item ids or the mark-all form are sent.
- The spec does not say what happens if the caller names an item they do not own. It could be ignored silently or rejected with an error.
- The spec does not say whether marking read sends a [realtime event](realtime-event.md) that other open sessions could use to refresh their [bell](notification-bell.md).

## Used by
<!-- used-by:start -->
- [caller-scoping](caller-scoping.md)
- [inbox-item](inbox-item.md)
- [mark-all-read](mark-all-read.md)
- [notification-bell](notification-bell.md)
- [realtime-event](realtime-event.md)
- [unread-count](unread-count.md)
- [watermark](watermark.md)
<!-- used-by:end -->
