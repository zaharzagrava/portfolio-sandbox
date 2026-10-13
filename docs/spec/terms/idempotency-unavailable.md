---
id: idempotency-unavailable
title: idempotency_unavailable (503)
kind: term
status: draft
aliases: [idempotency_unavailable]
defined_for: S54-platform-toolkit
rules_hash: e3b0c44298fc
---
# idempotency_unavailable (503)
## Definition
`idempotency_unavailable` is the error code returned with status 503 when the [idempotency store](idempotency-store.md) cannot be reached. It applies to a request on a route that requires an [Idempotency-Key](idempotency-key.md). The handler does not run, so the write is not performed. The store [fails closed ↗](../sw-external-terms.md#fail-open-fail-closed), so a duplicate side effect is never possible. The error body follows the usual [problem+json ↗](../sw-external-terms.md#problem-json) format.

## Example
The idempotency store is down. A client sends a required-key request to a route marked [`@Idempotent`](idempotent-decorator.md):
```
HTTP/1.1 503
Content-Type: application/problem+json

{ "status": 503, "code": "idempotency_unavailable", "requestId": "…", … }
```
The handler did not run. The client can retry later with the same key.

## Known gaps
- The spec does not say whether this response carries a `Retry-After` header (a [`retryAfterSeconds`](retry-after-seconds.md) extension member).
- The spec does not say what happens on routes where the key is optional and the store is unreachable.
- The spec does not give the [fixed catalogue text](error-catalogue.md) used for `detail`.

## Used by
<!-- used-by:start -->
- [error-catalogue](error-catalogue.md)
- [idempotency-key](idempotency-key.md)
- [idempotency-store](idempotency-store.md)
<!-- used-by:end -->
