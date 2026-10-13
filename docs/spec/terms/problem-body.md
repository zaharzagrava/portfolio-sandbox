---
id: problem-body
title: Problem body
kind: term
status: draft
aliases: [problem body member]
defined_for: W07-app-shell
rules_hash: 6366f4c4fd53
---
# Problem body
## Definition
The problem body is the JSON body that the backend sends with an error answer. It carries the HTTP `status`, the stable [`code`](error-code.md), a [`title`](problem-title.md) and a [`detail`](problem-detail.md). The web app uses it when a failed API call has no place of its own on the screen. In that case [`<ErrorState>`](error-state.md) picks its text using only `status` and `code`. The web app never shows `title` or `detail`, so no upstream text, stack trace or address reaches the screen.

## Example
A call to a product returns this problem body:
```json
{ "status": 404, "code": "product_not_found", "title": "Not Found", "detail": "…" }
```
`<ErrorState>` picks its text from `404` and `product_not_found`. The visitor never sees `"Not Found"` or the `detail` value. The `title` and `detail` values here are illustrative.

## Known gaps
- The spec does not say whether the problem body has more members than `status`, `code`, `title` and `detail`. It also does not say which content type the backend sends it with.
- The spec does not say whether the body follows the [standard HTTP problem-details format ↗](../sw-external-terms.md#problem-json). Write your parsing code for the four members named here, and don't assume any others.
- The spec does not say what text `<ErrorState>` shows when `code` is missing or not known to the web app.

## Used by
<!-- used-by:start -->
- [problem-title](problem-title.md)
<!-- used-by:end -->
