---
id: unknown-body-field
title: Unknown body field rejection
kind: term
status: draft
aliases: [extra field]
defined_for: S02-mfa-oidc
rules_hash: 111b9a70f9ed
---
# Unknown body field rejection
## Definition
A request body that contains a field the [endpoint](mfa-management-endpoint.md) does not define is rejected with [`400 validation_failed`](validation-failed-error.md). Nothing is changed, not even partially. The spec states this for the [confirm body](mfa-confirm.md), together with other malformed inputs such as a code with the wrong number of digits or with letters. Design intent (not stated in the spec): [strict bodies](strict-body.md) catch client typos early and stop callers from slipping extra fields into a write.

## Example
```http
POST /auth/mfa/confirm
{ "code": "123456", "enabled": true }
→ 400 validation_failed   (state stays [`pending`](mfa-state.md))
```
(The field names are illustrative.)

## Known gaps
- The spec does not say whether every other endpoint also rejects unknown fields. It only says so for confirm.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-03
- [S02](../capabilities/S02-mfa-oidc.md): B-03
- [S34](../capabilities/S34-recommendations.md): R-22
- [checkout-request-schema](checkout-request-schema.md)
- [mfa-confirm](mfa-confirm.md)
- [mfa-management-endpoint](mfa-management-endpoint.md)
- [strict-body](strict-body.md)
<!-- used-by:end -->
