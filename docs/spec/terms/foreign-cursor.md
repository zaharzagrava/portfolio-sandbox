---
id: foreign-cursor
title: Foreign cursor
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# Foreign cursor
## Definition
A foreign cursor is a [pagination cursor](pagination-cursor.md) for [`GET /notifications`](get-notifications.md) that the server [signed ↗](../sw-external-terms.md#digital-signature) for one user but a different caller sends back. Inbox cursors are signed and bound to the caller, so a cursor only works for the user it was issued to. A foreign cursor carries a valid signature, which makes it different from a [tampered cursor](tampered-cursor.md). The likely aim is to stop a cursor that was leaked or copied from exposing a page position in another user's inbox. That aim is design intent (not stated in the spec).

## Example
User A calls `GET /notifications` and gets a `nextCursor`. User B sends that same cursor in their own `GET /notifications` call. The cursor is bound to user A and not to user B, so it is not accepted for user B, and user B never sees user A's items.

## Known gaps
- The spec does not say what error code or HTTP status a foreign cursor gets. Another page lists [`invalid_cursor`](invalid-cursor.md), but nothing here confirms that this endpoint uses it.
- The spec does not say whether a foreign cursor and a tampered cursor get the same answer, so a client may not be able to tell them apart.
- The spec does not say how the binding is done, for example whether the caller's id is inside the signed data or is a key for the signature.

## Used by
<!-- used-by:start -->
- [pagination-cursor](pagination-cursor.md)
- [tampered-cursor](tampered-cursor.md)
<!-- used-by:end -->
