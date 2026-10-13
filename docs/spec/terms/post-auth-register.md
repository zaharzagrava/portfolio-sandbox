---
id: post-auth-register
title: POST /auth/register
kind: term
status: draft
aliases: [/auth/register]
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# POST /auth/register
## Definition
`POST /auth/register` is the public route that creates an account. It always returns [the same accepted response](identical-registration-response.md), whether or not the address is new, so callers can't use it to check which addresses have accounts. It never creates a [session](session-lifetime.md) and never returns tokens. It trims and lower-cases the address and accepts only the [`USER` or `SELLER` role](shop-role.md). It also applies [the password policy](password-problem.md), [the breached-password check](breached-password-check.md) and a [per-IP rate limit](rate-limit.md).

## Example
Registering `" New@Example.COM "` and then `"new@example.com"` gives both callers this response:
```
HTTP/1.1 202
{"status":"accepted"}
```
After both requests, one `USER` account exists as `new@example.com`. A body with `role: ADMIN` gets [`400 validation_failed`](validation-failed-error.md) instead.

## Known gaps
- The spec does not say how the owner of an existing address learns that someone tried to register it (for example, by email).
- The spec does not say whether the identical response also covers headers such as [`X-Request-Id`](request-id.md), or only the status and body.
- The spec does not say which fields the request body accepts, apart from the address, the password and `role`.

## Used by
<!-- used-by:start -->
- [breached-password-check](breached-password-check.md)
- [identical-registration-response](identical-registration-response.md)
- [password-problem](password-problem.md)
- [rate-limit](rate-limit.md)
- [session-lifetime](session-lifetime.md)
- [shop-role](shop-role.md)
<!-- used-by:end -->
