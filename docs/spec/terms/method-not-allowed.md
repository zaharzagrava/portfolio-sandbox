---
id: method-not-allowed
title: method_not_allowed (405)
kind: term
status: draft
aliases: [method_not_allowed]
defined_for: S54-platform-toolkit
rules_hash: e3b0c44298fc
---
# method_not_allowed (405)
## Definition
`method_not_allowed` is the [error code](error-code.md) returned when a route exists but does not support the HTTP method used. The response always includes an [`Allow` header ↗](../sw-external-terms.md#allow-header) that lists the methods the route does support. This sets it apart from [`not_found`](not-found-error.md), which is for a path that matches no route at all.

## Example
`/health/live` accepts only `GET` and `HEAD`, so a `DELETE` to it should get this response (illustrative):
```
HTTP/1.1 405
Allow: GET, HEAD
Content-Type: application/problem+json
```

## Known gaps
- Not confirmed in the code: that the health routes and [the management listener](management-listener.md) return `405` in the same way as ordinary app routes.

## Used by
<!-- used-by:start -->
- [error-code](error-code.md)
- [management-listener](management-listener.md)
<!-- used-by:end -->
