---
id: host-bff-cookies
title: __Host-bff-* cookies
kind: term
status: draft
aliases: [__host-bff-csrf, __host-bff-mfa, __host-bff-session]
defined_for: W01-auth-account
rules_hash: e3b0c44298fc
---
# __Host-bff-* cookies
## Definition
The `__Host-bff-*` cookies are the cookies the BFF sets to hold a browser's sign-in state. The browser holds no token, only these cookies. `__Host-bff-session` is HttpOnly and opaque. The BFF hashes its value to find the encrypted session record in Redis. `__Host-bff-csrf` is readable by page scripts, which copy its value into `X-CSRF-Token` on non-`GET` requests while signed in. `__Host-bff-mfa` is the cookie used during the second sign-in step.

## Example
A signed-in member's sign-out request carries the cookies plus the CSRF header (values are illustrative):
```
POST /api/bff/session/logout
Cookie: __Host-bff-session=k3Jx…; __Host-bff-csrf=abc123
X-CSRF-Token: abc123
```

## Known gaps
- The spec does not say what `__Host-bff-mfa` holds, or when it is set and cleared. Rule W01.R-13 only says the pending challenge must never be readable by scripts.
- The spec does not say how long these cookies last or which attributes they have, apart from `__Host-bff-session` being HttpOnly and `__Host-bff-csrf` being readable by scripts.
- The spec does not say whether sign-out or a session end clears these cookies in the response.

## Used by
<!-- used-by:start -->
- [get-api-bff-session](get-api-bff-session.md)
- [post-bff-session-logout](post-bff-session-logout.md)
- [post-bff-session-refresh](post-bff-session-refresh.md)
- [session-controller](session-controller.md)
<!-- used-by:end -->
