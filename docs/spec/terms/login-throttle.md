---
id: login-throttle
title: Login throttle
kind: term
status: draft
aliases: [login counter]
defined_for: S01-auth-sessions
rules_hash: 17182521e380
---
# Login throttle
## Definition
The login throttle is a [per-address rate limit](rate-limit.md) on password login. Once an address reaches its limit of attempts within the window, further logins get `429` with [`Retry-After` ↗](../sw-external-terms.md#retry-after). This happens even when the password is correct, and unregistered addresses are limited the same way. A successful login resets the counter. It is separate from the [per-IP login limit](rate-limit.md), and [trusted forwarding headers](forwarding-headers.md) do not affect it.

## Example
`alice@example.com` (illustrative) fails 5 logins from different IPs. The 6th attempt, within 15 minutes and with the right password, gets `429` with `Retry-After` (S01.B-07).

## Known gaps
- Not confirmed in the code: that this throttle is the [`auth.login.account` rate policy](rate-limit-policy.md). The name suggests it, but the facts do not link that policy to S01.R-09.
- The spec does not say whether successful logins also count toward the limit, or only failed ones. The rule says "the 6th login", while the behavior counts failed logins.
- The spec does not say which error code comes with the `429`. Registration uses `rate_limited`, but the login rule names only the status.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-09
- [forwarding-headers](forwarding-headers.md)
- [invalid-mfa-code](invalid-mfa-code.md)
- [mfa-challenge](mfa-challenge.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit](rate-limit.md)
- [reset-on-success](reset-on-success.md)
- [trusted-proxy](trusted-proxy.md)
<!-- used-by:end -->
