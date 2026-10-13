---
id: chat-unread
title: chatUnread
kind: term
status: draft
aliases: []
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# chatUnread
## Definition
`chatUnread` is an optional [section](section.md) of the product page that holds the signed-in viewer's unread chat data. [The BFF ↗](../sw-external-terms.md#bff) fetches it with the session's [access token](access-token.md) and passes the upstream answer through unchanged, [`nextCursor`](pagination-cursor.md) included. For an anonymous visitor the section does not apply: it is `null`, with no [errors entry](errors-entry.md) and no [upstream call](upstream.md).

## Example
A signed-in user opens `GET /api/bff/product-page/:productId`. The chat upstream gets `[Authorization: Bearer ↗](../sw-external-terms.md#authorization-bearer) <that session's token>`. The page includes:
```json
"chatUnread": { "items": [ ... ], "nextCursor": "abc123" }
```
(`items` and the cursor value are illustrative)

## Known gaps
- The spec does not say which fields `chatUnread` has besides `nextCursor`.
- The spec does not say which upstream endpoint serves this section.

## Used by
<!-- used-by:start -->
- [access-token](access-token.md)
- [errors-entry](errors-entry.md)
- [section](section.md)
- [upstream](upstream.md)
<!-- used-by:end -->
