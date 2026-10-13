---
id: error-state
title: Error state
kind: term
status: draft
aliases: []
defined_for: W07-app-shell
rules_hash: 5a01db430bcc
---
# Error state
## Definition
The error state is the screen the web app shows when something fails. It is drawn by `<ErrorState>`, for example when a failed API call has no other place on the screen. It picks its text only from the HTTP status and the [stable error `code`](error-code.md) of the [problem body ↗](../sw-external-terms.md#problem-json). It never shows `[title](problem-title.md)` or `[detail](problem-detail.md)`. This means no upstream text, stack trace or address can reach the visitor. [A rendering failure](rendering-failure.md) inside a page shows "Something went wrong" in `<main>`, and the header and footer stay usable.

## Example
A screen's API call fails with this problem body:
```json
{ "status": 503, "code": "search_unavailable", "title": "…", "detail": "…" }
```
`<ErrorState>` chooses its message from `503` and `search_unavailable`. It ignores `title` and `detail`.

## Known gaps
- The spec does not say which message goes with each status and `code`, or what is shown for a `code` the client does not know.
- The spec does not say how `<ErrorState>` relates to the "Something went wrong" text of `ErrorPage` (`packages/web/app/error.tsx`). For example, it is not stated whether they share a component.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): R-13
- [client-island](client-island.md)
- [error-code](error-code.md)
- [problem-title](problem-title.md)
- [rendering-failure](rendering-failure.md)
<!-- used-by:end -->
