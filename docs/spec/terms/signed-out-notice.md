---
id: signed-out-notice
title: signed_out notice
kind: term
status: draft
aliases: [notice=signed_out]
defined_for: W01-auth-account
rules_hash: e3b0c44298fc
---
# signed_out notice
## Definition
`signed_out` is the [`notice`](login-notice.md) value used when the browser lands on [`/login`](login-page.md) after a successful logout. The browser only goes there after the sign-out request has succeeded. If the request fails, the member stays signed in and sees a [toast](toast.md) instead. When the browser arrives with this value, the sign-in page shows a banner confirming the sign-out.

## Example
The member chooses **Log out**, and [`POST /api/bff/session/logout`](post-bff-session-logout.md) succeeds. [The cache is cleared](client-cache-clear.md), and the browser goes to `/login?notice=signed_out`.

## Known gaps
- The spec does not give the banner text for `signed_out`.
- The spec does not say whether a session that ends on its own (a [`401 session_expired`](session-expired.md)) also lands on this notice.

## Used by
<!-- used-by:start -->
- [client-cache-clear](client-cache-clear.md)
- [toast](toast.md)
<!-- used-by:end -->
