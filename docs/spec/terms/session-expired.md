---
id: session-expired
title: session_expired (401)
kind: term
status: draft
aliases: [session_expired]
defined_for: S48-bff
rules_hash: 619991117765
---
# session_expired (401)
## Definition
`session_expired` is the error code the [BFF ↗](../sw-external-terms.md#bff) returns with a 401 when it can no longer keep a browser session alive. It happens when the BFF tries a [token refresh](token-refresh.md) and the [identity domain](identity-domain.md) refuses it with [`invalid_refresh_token`](invalid-refresh-token-error.md). The BFF then moves the [session record](session-store.md) to [`ENDED`](session-revocation.md), so the client has to log in again. A refresh that only times out, while the access token is still valid, does not give this error: the request goes ahead and the session stays.

## Example
A signed-in visitor loads `GET /api/bff/product-page/:productId`. The session's access token is close to expiry, so the BFF calls the identity domain to refresh it. The identity domain answers `401 invalid_refresh_token`. The BFF ends the session and replies:
```
HTTP/1.1 401
code: session_expired   (problem body member; other body members not shown)
```

## Known gaps
- The spec does not say if the BFF clears the `__Host-bff-session` and `__Host-bff-csrf` cookies when it returns `session_expired`. It only says cookies are cleared on logout.
- The spec does not say if a session that ended for another reason (idle timeout, absolute lifetime, ended identity session) also gives `session_expired`, or some other 401 code.
- The spec does not say how the `POST /api/bff/session/refresh` route reports a refused refresh. That route has no specification entry and no test.

## Used by
<!-- used-by:start -->
- [W03](../capabilities/W03-cart-checkout-orders.md): B-15
- [identity-domain](identity-domain.md)
- [session-store](session-store.md)
- [token-refresh](token-refresh.md)
<!-- used-by:end -->
