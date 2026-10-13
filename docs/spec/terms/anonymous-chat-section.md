---
id: anonymous-chat-section
title: Chat section (anonymous)
kind: term
status: draft
aliases: [anonymous chat, chat]
defined_for: S48-bff
rules_hash: f5c0f9c26697
---
# Chat section (anonymous)
## Definition
The chat [section](section.md) is the optional [`chatUnread`](chat-unread.md) section of the product page. It needs a signed-in session. For an anonymous visitor, the section does not apply. It is `null`, with no [errors entry](errors-entry.md) and no [upstream call](upstream.md). For a signed-in viewer, the [BFF ↗](../sw-external-terms.md#bff) calls chat with that session's bearer token and passes `chatUnread` through with its [`nextCursor`](pagination-cursor.md).

## Example
An anonymous visitor (no `__Host-bff-session` cookie) loads the page. The answer has `"chatUnread": null` and no `chatUnread` entry in `errors`.

## Known gaps
- The spec does not say whether a request with only an `Authorization` header (no cookie) counts as signed in for the chat section.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): R-04
- [W02](../capabilities/W02-storefront-discovery.md): B-20
- [errors-entry](errors-entry.md)
- [page-upstream-sections](page-upstream-sections.md)
- [section](section.md)
- [upstream](upstream.md)
<!-- used-by:end -->
