---
id: extension-members
title: Extension members
kind: term
status: draft
aliases: [extension member]
defined_for: problem-json-errors
rules_hash: d39080784614
---
# Extension members
## Definition
Extension members are extra fields that an error adds to a [problem+json ↗](../sw-external-terms.md#problem-json) body, beyond the standard fields that every such body may carry. They carry details that only some errors need. An extension member must never replace or overwrite one of those standard fields. Some extension members also change the response headers. For example, [`retryAfterSeconds`](retry-after-seconds.md) produces a [`Retry-After` header ↗](../sw-external-terms.md#retry-after).

## Example
An [S50](../capabilities/S50-rate-limiter.md) rate-limit rejection could add `retryAfterSeconds` next to the reserved members:
```json
{ "code": "rate_limited", "status": 429, "retryAfterSeconds": 30, "requestId": "..." }
```
(The `code`, `status` and values are illustrative.)

## Known gaps
- The spec does not say how extension members fit with C-01. C-01 says a body has "exactly" the reserved members, plus `traceId`.
- The spec does not say what happens when an extension tries to override a reserved member. It could be dropped, fail at startup, or cause a [`500 internal_error`](internal-error.md).
- The spec does not give a full list of allowed extension members. `retryAfterSeconds` is the only one it names.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-06
- [problem-json-errors](../concepts/problem-json-errors.md): C-05
- [exact-body-members](exact-body-members.md)
- [order-not-cancellable](order-not-cancellable.md)
- [price-changed](price-changed.md)
- [problem-instance](problem-instance.md)
- [reserved-members](reserved-members.md)
- [retry-after-seconds](retry-after-seconds.md)
- [too-many-connections](too-many-connections.md)
<!-- used-by:end -->
