---
id: error-catalogue
title: Error catalogue (fixed detail text)
kind: term
status: draft
aliases: [catalogue, catalogue text]
defined_for: problem-json-errors
rules_hash: 4a7af643743d
---
# Error catalogue (fixed detail text)
## Definition
The error catalogue holds the fixed, generic [`detail`](problem-detail.md) text for each [error code](error-code.md). For any status of 500 or above, the body's `detail` always comes from this catalogue. Thrown messages, wrapped causes, SQL and stack traces never reach the body, in any environment. If rendering itself fails, [the filter](problem-exception-filter.md) emits a minimal `500 internal_error` instead.

## Example
A repository throws an error whose message includes a failing SQL statement. The client sees only `"status": 500, "code": "internal_error"` and the catalogue's fixed `detail` text. The SQL stays in the server logs.

## Known gaps
- The spec does not say what the catalogue's actual texts are, or where the catalogue is stored.
- Not confirmed in the code: this catalogue is the same thing as the [code registration](error-code-registration.md) that fails startup on duplicate definitions.
- The spec does not say how this server-side catalogue relates to the copy catalogue that {{cap:W01}} builds from the problem body (FR-040). Treat them as separate.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-02
- [problem-json-errors](../concepts/problem-json-errors.md): C-02
- [conflict-error](conflict-error.md)
- [error-code-registration](error-code-registration.md)
- [error-code](error-code.md)
- [form-alert](form-alert.md)
- [idempotency-unavailable](idempotency-unavailable.md)
- [identity-not-found](identity-not-found.md)
- [internal-error](internal-error.md)
- [invalid-code](invalid-code.md)
- [problem-detail](problem-detail.md)
- [problem-exception-filter](problem-exception-filter.md)
- [unsupported-media-type](unsupported-media-type.md)
<!-- used-by:end -->
