---
id: reserved-members
title: Reserved members
kind: term
status: draft
aliases: [reserved member]
defined_for: problem-json-errors
rules_hash: 4ce84aa7d9a8
---
# Reserved members
## Definition
Reserved members are the fixed fields that every [problem+json ↗](../sw-external-terms.md#problem-json) error body has: `type`, `title`, `status`, `detail`, `instance`, [`code`](error-code.md) and [`requestId`](request-id.md). [`traceId`](trace-id.md) is added when a trace is active. Clients rely on these fields always meaning the same thing, so [extension members](extension-members.md) must not override them. Clients pick their behaviour from `code`, never from the message text.

## Example
```json
{
  "type": "...", "title": "Conflict", "status": 409,
  "detail": "...", "instance": "/checkout",
  "code": "conflict", "requestId": "0192f3a1-...", "traceId": "..."
}
```
(The `title`, `instance`, `requestId` and `traceId` values are illustrative.)

## Known gaps
- The spec does not say directly whether `traceId` counts as a reserved member. It is only listed as present when a trace is active.
- The spec does not say what values go in `type` and `instance`.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-06
- [problem-json-errors](../concepts/problem-json-errors.md): C-05
- [extension-members](extension-members.md)
- [problem-instance](problem-instance.md)
<!-- used-by:end -->
