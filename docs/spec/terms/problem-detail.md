---
id: problem-detail
title: detail (problem body member)
kind: term
status: draft
aliases: [detail text]
defined_for: problem-json-errors
rules_hash: 260bf6c0007d
---
# detail (problem body member)
## Definition
`detail` is one of the fixed members of every [problem+json ↗](../sw-external-terms.md#problem-json) error body. It holds a human-readable explanation of this particular error. For server errors, `detail` is always the [fixed catalogue text](error-catalogue.md). Thrown messages, wrapped causes, SQL and stack traces never appear in it, in any environment. Clients must not branch on `detail`; they choose behaviour by [`code`](error-code.md), and `detail` is only for display or logs.

## Example
A repository call fails, and the thrown error message contains a SQL statement. The client receives only the catalogue text (detail wording is illustrative):
```json
{ "status": 500, "code": "internal_error", "title": "Internal error",
  "detail": "An unexpected error occurred.", "requestId": "…" }
```
The SQL stays in the server logs, and support can find it there by [`requestId`](request-id.md).

## Known gaps
- The spec does not say what `detail` may contain below the server-error range, for example whether a thrown message may pass through on a 4xx.
- The spec does not give the actual catalogue texts.
- The spec does not say whether the "generic text" of a [`409 conflict`](conflict-error.md), or the field list of [`validation_failed`](validation-failed-error.md), goes in `detail` or in another member.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): R-06
- [request-context](../concepts/request-context.md): C-03
- [error-catalogue](error-catalogue.md)
- [retry-after-seconds](retry-after-seconds.md)
<!-- used-by:end -->
