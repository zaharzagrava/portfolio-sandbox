---
id: internal-error
title: internal_error (500)
kind: term
status: draft
aliases: [internal_error]
defined_for: problem-json-errors
rules_hash: e3b0c44298fc
---
# internal_error (500)
## Definition
`internal_error` is the stable [`code`](error-code.md) of a generic server failure with status `500`. It is also the fallback that the [problem exception filter](problem-exception-filter.md) emits when rendering the real error fails. Because the status is 500 or above, [`detail`](problem-detail.md) is always the [fixed catalogue text](error-catalogue.md). Thrown messages, causes, SQL and stack traces never appear in the body.

## Example
```json
{ "status": 500, "code": "internal_error", "title": "...", "detail": "<fixed catalogue text>", "requestId": "0192f3a1-..." }
```
(The values are illustrative.) Clients can report the [`requestId`](request-id.md) so that the failure can be matched to the logs.

## Known gaps
- The spec does not say whether `internal_error` is also the code for *any* unhandled exception, or only for the rendering fallback.
- The spec does not give the catalogue text for `internal_error`.

## Used by
<!-- used-by:start -->
- [error-catalogue](error-catalogue.md)
- [problem-exception-filter](problem-exception-filter.md)
<!-- used-by:end -->
