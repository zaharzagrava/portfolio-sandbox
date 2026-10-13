---
id: host-refresh-cookie
title: __Host-refresh cookie
kind: term
status: draft
aliases: [__host-refresh]
defined_for: S01-auth-sessions
rules_hash: d49748e05a46
---
# __Host-refresh cookie
## Definition
`__Host-refresh` is the cookie that carries the [refresh token](token-refresh.md) when a login uses [cookie delivery](cookie-delivery.md) (`delivery: "cookie"`). It is [HttpOnly ↗](../sw-external-terms.md#httponly), so scripts on the page cannot read it. A cookie-mode refresh needs no token in the body: it reads this cookie and [rotates](refresh-token-rotation.md) it together with [`__Host-access`](host-access-cookie.md) and [`__Host-csrf` ↗](../sw-external-terms.md#csrf-token). A refresh refused by the [CSRF check ↗](../sw-external-terms.md#csrf-token) does not spend it. Cookie-mode logout clears it.

## Example
```
Set-Cookie: __Host-refresh=<opaque refresh token>; HttpOnly; Secure; SameSite=Lax; Path=/
```

## Known gaps
- The spec does not say which `Max-Age` or `Expires` the cookie gets, or how it relates to the refresh token's own expiry.
- The spec does not say what happens when a cookie-mode request also sends a refresh token in the body.

## Used by
<!-- used-by:start -->
- [cookie-delivery](cookie-delivery.md)
- [post-auth-refresh](post-auth-refresh.md)
- [refresh-token-rotation](refresh-token-rotation.md)
- [token-refresh](token-refresh.md)
<!-- used-by:end -->
