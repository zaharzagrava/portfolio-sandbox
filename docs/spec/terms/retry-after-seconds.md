---
id: retry-after-seconds
title: retryAfterSeconds
kind: term
status: draft
aliases: []
defined_for: problem-json-errors
rules_hash: d7aa31b0609d
---
# retryAfterSeconds
## Definition
`retryAfterSeconds` is an [extension member](extension-members.md) that tells the client how long to wait before trying again. When an [error body](problem-detail.md) contains it, the response must also include the standard [`Retry-After` header ↗](../sw-external-terms.md#retry-after). The design intent (not stated in the spec) is that HTTP clients and proxies that only read headers can still back off correctly.

## Example
```
HTTP/1.1 429 Too Many Requests
Retry-After: 30
Content-Type: application/problem+json

{ "code": "rate_limited", "retryAfterSeconds": 30, ... }
```
(The status, [`code`](error-code.md) and values are illustrative.)

## Known gaps
- The spec does not say which errors set `retryAfterSeconds`. [S50 rate-limit rejections](../capabilities/S50-rate-limiter.md) are a likely user, but this is not confirmed.
- The spec does not say whether the member stays in the body after the header is produced. The example above assumes it does.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): R-09
- [extension-members](extension-members.md)
- [problem-detail](problem-detail.md)
<!-- used-by:end -->
