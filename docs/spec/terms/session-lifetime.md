---
id: session-lifetime
title: Session lifetime
kind: term
status: draft
aliases: [session]
defined_for: access-token-session
rules_hash: 8671da3b1a1b
---
# Session lifetime
## Definition
Session lifetime is the hard limit on how long a session can last, counted from the moment it was created. A session can be kept going past the expiry of its current credential, because the user can trade that credential for a new one, and each new one comes with its own expiry. However many times this happens, the session still can't run past its lifetime. After that the user has to sign in again.

## Example
A user signs in on 2026-01-01 and their client refreshes regularly. The session still ends on 2026-04-01, 90 days after creation. The next refresh then fails with [`401 invalid_refresh_token`](invalid-refresh-token-error.md).

## Known gaps
- The spec does not say whether a refresh token issued near the end of a session has its expiry cut short to match the session end.
- The spec does not say whether the user is warned before the session ends.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-01, R-13, R-22, R-25, R-27, B-06, B-09, B-12, B-18, B-26
- [S02](../capabilities/S02-mfa-oidc.md): R-28
- [S10](../capabilities/S10-cart-checkout.md): R-08
- [S48](../capabilities/S48-bff.md): B-18
- [W01](../capabilities/W01-auth-account.md): R-18, B-15
- [access-token-session](../concepts/access-token-session.md): C-06
- [account-unavailable](account-unavailable.md)
- [clock-skew-tolerance](clock-skew-tolerance.md)
- [cookie-delivery](cookie-delivery.md)
- [get-auth-sessions](get-auth-sessions.md)
- [linked-query-param](linked-query-param.md)
- [mfa-challenge](mfa-challenge.md)
- [post-auth-register](post-auth-register.md)
- [service-to-service-token](service-to-service-token.md)
- [session-created-at](session-created-at.md)
- [session-last-used-at](session-last-used-at.md)
- [session-limit](session-limit.md)
- [token-refresh](token-refresh.md)
<!-- used-by:end -->
