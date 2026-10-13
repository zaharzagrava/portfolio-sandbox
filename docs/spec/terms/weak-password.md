---
id: weak-password
title: weak_password (422)
kind: term
status: draft
aliases: [weak_password]
defined_for: S01-auth-sessions
rules_hash: 9a4750154f9a
---
# weak_password (422)
## Definition
`weak_password` is the error code [S01](../capabilities/S01-auth-sessions.md) returns, with [HTTP status 422 ↗](../sw-external-terms.md#http-422-unprocessable-content), when it refuses a password during registration. A [breached password](breached-password.md) gives this error for new and for existing addresses alike, so the response does not reveal whether an account exists. Nothing is stored when it is returned.

## Example
```
POST /auth/register
{"email": "new@example.com", "password": "<a breached password>"}
→ 422 weak_password
```

## Known gaps
- The spec does not say whether the other password-rule failures (wrong length, password equal to the address) also give `422 weak_password` or a different code. A password that is too long gives `400` at login.
- The spec does not say whether the response names which rule the password failed.

## Used by
<!-- used-by:start -->
- [breached-password-check](breached-password-check.md)
- [breached-password](breached-password.md)
<!-- used-by:end -->
