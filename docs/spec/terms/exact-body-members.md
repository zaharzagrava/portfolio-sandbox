---
id: exact-body-members
title: Exact problem body members
kind: term
status: draft
aliases: [exactly the listed members]
defined_for: problem-json-errors
rules_hash: 29a5939ae99a
---
# Exact problem body members
## Definition
Every error body holds a fixed set of members: `type`, `title`, `status`, `detail`, `instance`, [`code`](error-code.md) and [`requestId`](request-id.md). It also holds [`traceId`](trace-id.md), but only when a trace is active. The word "exactly" means the [problem exception filter](problem-exception-filter.md) must not add other top-level members of its own. This gives clients a body shape they can rely on, and it stops internals from leaking through extra fields. That reason is design intent (not stated in the spec).

## Example
```json
{
  "type": "…", "title": "Conflict", "status": 409,
  "detail": "…catalogue text…", "instance": "/checkout",
  "code": "conflict", "requestId": "0192…(illustrative)",
  "traceId": "4bf9…(illustrative, only when a trace is active)"
}
```

## Known gaps
- The spec does not say how "exactly" fits with [extension members](extension-members.md). The rule lets them exist (for example `retryAfterSeconds`) but only forbids them from overriding a reserved member.
- The spec does not say where `validation_failed` puts its list of failing fields, given that the body holds only these members.
- The spec does not say what `type` and `instance` contain.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-01
- [cell-unavailable](cell-unavailable.md)
- [currency-not-supported](currency-not-supported.md)
- [extension-members](extension-members.md)
- [form-alert](form-alert.md)
- [order-not-found](order-not-found.md)
- [problem-exception-filter](problem-exception-filter.md)
- [unknown-query-parameter](unknown-query-parameter.md)
- [validation-failed-error](validation-failed-error.md)
<!-- used-by:end -->
