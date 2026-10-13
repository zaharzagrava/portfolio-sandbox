---
id: validation-failed-error
title: validation_failed error
kind: term
status: draft
aliases: [validation_failed]
defined_for: problem-json-errors
rules_hash: cebf2bca806e
---
# validation_failed error
## Definition
`validation_failed` is the error code returned with status `400` when request input fails validation. It lists every failing field in one response, so the client can fix them all at once. It never echoes the submitted values back. The design intent (not stated in the spec) is to keep passwords or personal data out of responses and logs.

## Example
A request is sent with a missing email and a password that is too short. The response is `400` with `"code": "validation_failed"`, and it names both fields, `email` and `password`. The submitted values are not included.

## Known gaps
- The spec does not say which member carries the list of failing fields, or its shape. The rule that the body holds "[exactly](exact-body-members.md)" the listed members makes this unclear.
- Not confirmed in the code: [{{cap:S53}}](../capabilities/S53-events-projections.md)'s `400` for an invalid [`minVersion`](min-version.md) uses the `validation_failed` code.

## Used by
<!-- used-by:start -->
- [exact-body-members](exact-body-members.md)
- [register-page](register-page.md)
<!-- used-by:end -->
