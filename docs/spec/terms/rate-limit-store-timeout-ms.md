---
id: rate-limit-store-timeout-ms
title: rate_limit_store_timeout_ms
kind: term
status: draft
aliases: []
defined_for: S50-rate-limiter
rules_hash: e3b0c44298fc
---
# rate_limit_store_timeout_ms
## Definition
`rate_limit_store_timeout_ms` is the configuration key that sets how long a [limiter call to the shared store](rate-limit-counter-store.md) may take. If a call takes longer, it counts as a failed store call, just like a call that errors. The policy's [fail mode](rate-limit-fail-mode.md) then decides the outcome. The limiter does not retry the call itself. A timed-out call is a store failure, so it also counts toward opening the [circuit breaker ↗](../sw-external-terms.md#circuit-breaker).

## Example
The default is 200 ms. Suppose a store call takes 350 ms (illustrative) on a policy with [`failMode: 'closed'`](rate-limit-fail-mode.md). The decision becomes `allowed: false`, `reason: 'store-unavailable'`, and HTTP answers `503` [`rate_limiter_unavailable`](rate-limiter-unavailable.md) with [`Retry-After: 1` ↗](../sw-external-terms.md#retry-after).

## Known gaps
- The spec does not say whether a timed-out store call is cancelled. A late call may still change counters in the store.
- The spec does not say whether a policy can override this key or whether it applies fleet-wide only.

## Used by
<!-- used-by:start -->
- [rate-limit-counter-store](rate-limit-counter-store.md)
- [rate-limit-fail-mode](rate-limit-fail-mode.md)
<!-- used-by:end -->
