---
id: clock-skew-tolerance
title: Clock skew tolerance
kind: term
status: draft
aliases: [tolerance]
defined_for: access-token-session
rules_hash: 87f2e616ff31
---
# Clock skew tolerance
## Definition
The clock skew tolerance is the small allowance used when checking a token's time against the verifier's clock. It allows for clocks on different servers drifting slightly apart. A token whose time falls outside this allowance is rejected with [`invalid_token`](invalid-token-error.md).

## Example
With the 5 s tolerance, a token with [`exp` ↗](../sw-external-terms.md#jwt-exp) = 12:00:00 is still accepted at 12:00:03 by the verifier's clock. At 12:00:06 it is rejected with `401 invalid_token`. The times are illustrative.

## Known gaps
- The spec says only "a time". It does not say which claims the tolerance covers (`exp`, [`nbf` ↗](../sw-external-terms.md#jwt-nbf), [`iat` ↗](../sw-external-terms.md#jwt-iat)).
- The spec does not say whether the same tolerance applies to [refresh token](token-refresh.md) or [session](session-lifetime.md) expiry.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-15
- [access-token-session](../concepts/access-token-session.md): C-03
- [access-token](access-token.md)
- [session-lifetime](session-lifetime.md)
- [stock-verifier](stock-verifier.md)
- [token-refresh](token-refresh.md)
- [totp-time-step](totp-time-step.md)
- [verify-stripe-signature](verify-stripe-signature.md)
- [verify-totp](verify-totp.md)
- [webhook-secret](webhook-secret.md)
<!-- used-by:end -->
