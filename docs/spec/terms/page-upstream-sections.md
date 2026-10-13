---
id: page-upstream-sections
title: Flags and chat sections
kind: term
status: draft
aliases: [chat, flags]
defined_for: S48-bff
rules_hash: 1eb3df198493
---
# Flags and chat sections
## Definition
Flags and chat are the [product page sections](section.md) that call their [upstreams](upstream.md) on the viewer's behalf. When a session exists, the [BFF ↗](../sw-external-terms.md#bff) attaches that session's [access token](access-token.md) to these calls. With an anonymous visitor, no `Authorization` header goes upstream. An upstream 401 on one of these credentialed calls fails the whole page with `[401 invalid_token](invalid-token-error.md)`, instead of [degrading only that section](degraded.md).

## Example
User A's session loads the page. The `flags` and [`chatUnread`](chat-unread.md) upstream calls each carry [`Authorization: Bearer <A's token>` ↗](../sw-external-terms.md#authorization-bearer). That token is sent only to the configured [domain-API origin](domain-api-origin.md). Interleaved requests from user B carry only B's token.

## Known gaps
- The spec does not say what the `flags` section contains, or whether it applies to anonymous visitors. It only says [anonymous chat](anonymous-chat-section.md) is "not applicable".
- The spec does not say whether any other section sends the session's token. The list of credentialed sections is not stated.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): B-02
- [access-token](access-token.md)
- [anonymous-chat-section](anonymous-chat-section.md)
- [degraded](degraded.md)
- [domain-api-origin](domain-api-origin.md)
- [section](section.md)
- [upstream](upstream.md)
<!-- used-by:end -->
