---
id: firewall-route
title: Firewall() route
kind: term
status: draft
aliases: [firewall]
defined_for: S13-payment-intents
rules_hash: e3b0c44298fc
---
# Firewall() route
## Definition
`Firewall()` is the marker that protects a route in this system. A plain `Firewall()` route does not check against [Redis ↗](../sw-external-terms.md#redis) whether the caller's access was [revoked](session-revocation.md). As a result, a Redis outage does not block requests to that route. The payments read routes, `GET /payments/:paymentId` and `GET /payments`, are plain `Firewall()` routes. Their [rate limit](rate-limit.md) also [fails open ↗](../sw-external-terms.md#fail-open-fail-closed), so buyers can still read payments while Redis is down.

## Example
Redis is down. A buyer calls `GET /payments/:paymentId` for their own payment and still gets the payment back. The route skips the Redis revocation check, and its 120-per-minute limit fails open. If the buyer uses [`POST /payments/intents`](payment-intent.md) instead, that limit fails closed, so it cannot work the same way.

## Known gaps
- The spec does not say what a plain `Firewall()` route does check (for example token signature or expiry). It also does not say which callers it lets through.
- The spec does not name the stricter variant that does check revocation against Redis, or say which routes use it.
- The spec does not say how long a revoked session can keep reading through a plain `Firewall()` route. Skipping the revocation check suggests a revoked caller may still get through for a while.

## Used by
<!-- used-by:start -->
- [rate-limit](rate-limit.md)
- [session-revocation](session-revocation.md)
<!-- used-by:end -->
