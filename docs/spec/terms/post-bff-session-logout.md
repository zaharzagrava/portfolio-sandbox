---
id: post-bff-session-logout
title: POST /api/bff/session/logout
kind: term
status: draft
aliases: [/api/bff/session/logout, logout]
defined_for: W01-auth-account
rules_hash: e3b0c44298fc
---
# POST /api/bff/session/logout
## Definition
`POST /api/bff/session/logout` is the [BFF ↗](../sw-external-terms.md#bff) endpoint that signs a member out. Because it is a non-`GET` request made while signed in, it must carry [`X-CSRF-Token` ↗](../sw-external-terms.md#csrf-token). The interface shows the anonymous state only after this request succeeds. On success, the [client cache is cleared](client-cache-clear.md) and the browser goes to `/login?notice=signed_out`. If it fails, the member stays signed in and sees a [toast](toast.md).

## Example
```
POST /api/bff/session/logout
Cookie: __Host-bff-session=<opaque>; __Host-bff-csrf=abc123   (illustrative)
X-CSRF-Token: abc123
```
On success, other open tabs learn about the sign-out through the [`auth` BroadcastChannel ↗](../sw-external-terms.md#broadcast-channel) and switch to the anonymous navbar.

## Known gaps
- The spec does not say what the server does with the session. It does not say whether the [Redis session record](session-store.md) is deleted or whether the [`__Host-bff-*` cookies](host-bff-cookies.md) are cleared in the response.
- The spec does not give the success status or response body, or the error codes this endpoint can return.
- Not confirmed in the code: which of [S01, S02 or S48](capability.md) owns this endpoint. The page only says `/api/bff/session*` is owned by those capabilities as a group.

## Used by
<!-- used-by:start -->
- [capability](capability.md)
- [client-cache-clear](client-cache-clear.md)
- [host-bff-cookies](host-bff-cookies.md)
- [session-store](session-store.md)
- [toast](toast.md)
<!-- used-by:end -->
