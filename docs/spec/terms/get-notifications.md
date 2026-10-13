---
id: get-notifications
title: GET /notifications
kind: term
status: draft
aliases: [/notifications]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# GET /notifications
## Definition
`GET /notifications` is the inbox listing endpoint on [`NotificationsController`](notifications-controller.md). It returns only the caller's own [inbox items](inbox-item.md), newest first by event time and then by id. Results come in pages, and each page links to the next with a [signed cursor](pagination-cursor.md) that is bound to the caller. A cursor issued to one user cannot page through another user's inbox. Items older than the [inbox retention period](bounded-retention.md) are not returned.

## Example
`GET /notifications?limit=20` returns the caller's 20 newest inbox items, for example an order update and a chat message. The caller then sends the cursor from that answer to get the next 20. If a different signed-in user sends the same cursor, the request is refused.

## Known gaps
- The spec does not say what fields an inbox item has, how the answer body is shaped, or which query parameter carries the cursor.
- The spec does not say which error is returned for a foreign, [tampered](tampered-cursor.md) or out-of-range cursor, or for a `limit` outside the allowed range.
- The spec does not say whether retention deletes old items or only hides them from this endpoint.

## Used by
<!-- used-by:start -->
- [bounded-retention](bounded-retention.md)
- [inbox-item](inbox-item.md)
- [pagination-cursor](pagination-cursor.md)
- [tampered-cursor](tampered-cursor.md)
<!-- used-by:end -->
