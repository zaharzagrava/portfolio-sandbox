---
id: mark-all-read
title: Mark all read
kind: term
status: draft
aliases: [mark-all]
defined_for: S28-notifications
rules_hash: e50db19339f4
---
# Mark all read
## Definition
Mark all read sets every unread [inbox item](inbox-item.md) of the caller to read in one action. It uses a [watermark](watermark.md): only items at or before the watermark are marked. Items that arrive while the request is running, or after it, stay unread. Like single-item marking, it is [idempotent ↗](../sw-external-terms.md#idempotency), [scoped to the owner](caller-scoping.md), and lowers the unread count once per item.

## Example
At 10:00:00 a user presses "mark all read" with 7 unread items. A new item arrives at 10:00:01, while the request is still running (illustrative times). The 7 older items become read, the new one stays unread, and [the bell](notification-bell.md) shows 1.

## Known gaps
- The spec does not say whether mark-all is a variant of [`POST /notifications/read`](post-notifications-read.md) or a separate route, or what the request body looks like.
- The spec does not say what the watermark is based on (event time, item id or arrival time), or who sets it (client or server).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-40
- [caller-scoping](caller-scoping.md)
- [inbox-item](inbox-item.md)
- [notification-bell](notification-bell.md)
- [post-notifications-read](post-notifications-read.md)
- [unread-count](unread-count.md)
- [watermark](watermark.md)
<!-- used-by:end -->
