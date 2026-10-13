---
id: host-bff-mfa-cookie
title: __Host-bff-mfa cookie
kind: term
status: draft
aliases: [__host-bff-mfa]
defined_for: bff-aggregate
rules_hash: e3b0c44298fc
---
# __Host-bff-mfa cookie
## Definition
`__Host-bff-mfa` is one of the cookies the [BFF ↗](../sw-external-terms.md#bff) sets in the browser, next to the [session cookie](session-cookie.md) and the [`__Host-bff-csrf` cookie ↗](../sw-external-terms.md#csrf-token). The facts name it but do not say what it holds, when it is set or when it is cleared. Its name and the [MFA step-up flow ↗](../sw-external-terms.md#mfa-step-up) in W01 suggest it carries state during an MFA step. That reading is an inference from the name, not stated in the spec or the code notes. As with the other BFF cookies, it does not hold a token, because browsers never hold one.

## Example
The cookies that the code notes list for the BFF:
```
__Host-bff-session   [HttpOnly ↗](../sw-external-terms.md#httponly), opaque           (the session cookie)
__Host-bff-csrf      readable by page scripts   (the CSRF token)
__Host-bff-mfa       purpose not stated in the facts
```

## Known gaps
- The spec does not say what the cookie contains, when the BFF sets or clears it, or how long it lasts.
- Not confirmed in the code: whether the cookie is HttpOnly, and whether its state is kept in the session store like session records.
- The spec does not say whether a request carrying only this cookie counts as cookie-bearing. That matters for [`400 ambiguous_credentials`](ambiguous-credentials.md) and `503 session_unavailable`.

## Used by
<!-- used-by:start -->
- [login-mfa-page](login-mfa-page.md)
- [post-bff-session](post-bff-session.md)
- [session-cookie](session-cookie.md)
- [session-store](session-store.md)
<!-- used-by:end -->
