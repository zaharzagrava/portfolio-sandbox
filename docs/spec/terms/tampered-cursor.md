---
id: tampered-cursor
title: Tampered cursor
kind: term
status: draft
aliases: [tampered]
defined_for: S28-notifications
rules_hash: 17a5be488e65
---
# Tampered cursor
## Definition
A tampered cursor is a [pagination cursor](pagination-cursor.md) for [`GET /notifications`](get-notifications.md) that someone changed after the server [signed ↗](../sw-external-terms.md#digital-signature) it. [Inbox](inbox-item.md) cursors are signed and bound to the caller, so a changed cursor no longer matches its signature and the server refuses it. The likely aim is to stop a client from inventing a page position or reading another user's inbox. That aim is design intent (not stated in the spec).

## Example
A client gets a [`nextCursor`](pagination-cursor.md) from `GET /notifications`, edits a few characters in it, and sends it back to fetch the next page. The signature check fails and the request is refused. It returns no items.

## Known gaps
- The spec does not say which error code or HTTP status a tampered cursor gets. Another existing page lists [`invalid_cursor`](invalid-cursor.md), but nothing here confirms that this endpoint uses it.
- The spec does not say whether a tampered cursor and a [foreign cursor](foreign-cursor.md) (a valid cursor issued to another user) get the same answer.

## Used by
<!-- used-by:start -->
- [foreign-cursor](foreign-cursor.md)
- [get-notifications](get-notifications.md)
- [inbox-item](inbox-item.md)
- [pagination-cursor](pagination-cursor.md)
<!-- used-by:end -->
