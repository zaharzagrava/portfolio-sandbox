---
id: problem-instance
title: instance (problem body member)
kind: term
status: draft
aliases: [instance]
defined_for: S54-platform-toolkit
rules_hash: e3b0c44298fc
---
# instance (problem body member)
## Definition
`instance` is one of the [reserved members](reserved-members.md) of every [problem+json ↗](../sw-external-terms.md#problem-json) error body. It identifies the request that failed. On routes with a [sensitive path parameter](sensitive-path-parameter.md) it holds the [route template](sensitive-path-parameter.md), not the real path. [Extension members](extension-members.md) cannot override it.

## Example
For `order_not_found` (S54.B-01), the body might look like this (values are illustrative):
```json
{ "type": "…", "title": "…", "status": 404, "code": "order_not_found",
  "detail": "…", "instance": "/orders/123", "requestId": "…" }
```

## Known gaps
- The spec does not say what `instance` holds on ordinary routes: the full request path, the path with its query string, or something else.
- The spec does not say what `instance` contains for errors raised outside an HTTP request, such as the minimal fallback [`500 internal_error`](internal-error.md).

## Used by
<!-- used-by:start -->
- [extension-members](extension-members.md)
- [reserved-members](reserved-members.md)
- [sensitive-path-parameter](sensitive-path-parameter.md)
<!-- used-by:end -->
