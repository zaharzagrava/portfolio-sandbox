---
id: problem-title
title: title (problem body member)
kind: term
status: draft
aliases: [title]
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# title (problem body member)
## Definition
`title` is a member of the [problem body](problem-body.md) that the backend returns with an error answer. Next to it are `status`, the stable [`code`](error-code.md) and [`detail`](problem-detail.md). The web app must never use `title` as on-screen text in an [error state](error-state.md). The stated reason is that error text comes only from the status and `code`, so no [upstream](upstream.md) text reaches the screen.

## Example
```json
{ "status": 404, "code": "product_not_found", "title": "Not Found", "detail": "…" }
```
The error state shows text chosen from `404` and `product_not_found`. `"Not Found"` is never displayed. The `title` value here is illustrative.

## Known gaps
- The spec does not say what the backend puts in `title`, or whether it is stable enough for a client to rely on. Use `code` for any logic.

## Used by
<!-- used-by:start -->
- [error-state](error-state.md)
- [problem-body](problem-body.md)
- [upstream](upstream.md)
<!-- used-by:end -->
