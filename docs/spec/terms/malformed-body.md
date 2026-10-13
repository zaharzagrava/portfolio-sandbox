---
id: malformed-body
title: malformed_body (400)
kind: term
status: draft
aliases: [malformed_body]
defined_for: S54-platform-toolkit
rules_hash: e3b0c44298fc
---
# malformed_body (400)
## Definition
`malformed_body` is the error code returned when a request body is not valid JSON. The problem exception filter renders it as a problem+json response with a client error status. The handler never runs because the body cannot be parsed. It is different from `validation_failed`, which is for JSON that parses but breaks the route's schema.

## Example
A client sends `POST` with the body `{"name": ` (it is cut off) and receives:
```json
{ "status": 400, "code": "malformed_body", "requestId": "…" }
```
The other required members are left out here, and the values are illustrative.

## Known gaps
- The spec does not say what `detail` text a `malformed_body` response carries.
- The spec does not say whether an empty body on a route that expects JSON counts as `malformed_body`.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
