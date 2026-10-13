---
id: rate-limit-subject-fallback
title: Subject fallback counter
kind: term
status: draft
aliases: [fallback, fallback counter]
defined_for: S50-rate-limiter
rules_hash: 886766a20b6e
---
# Subject fallback counter
## Definition
The subject fallback counter counts the times a [policy](rate-limit-policy.md) could not use its own [kind of subject](rate-limit-subject.md) and instead keyed the request by the caller's network address. This happens when a user, API-key or shop policy gets a request without that identity. Operators watch it to find routes where identity-keyed limits are really working as per-address limits. Do not confuse it with the [in-process fallback limiter](fallback-token-bucket.md). That limiter decides only when the shared store fails under [fail open ↗](../sw-external-terms.md#fail-open-fail-closed).

## Example
A shop-keyed policy gets a request with no shop identity. The request is limited by the client address, and the counter goes up by one. The page lists the metric `rate_limit_subject_fallback_total`, which is probably this counter.

## Known gaps
- The spec does not say directly that "the fallback counter" is `rate_limit_subject_fallback_total`. It also does not say which labels the metric has (metric contents, AS-74 and AS-75, are not stated as rules).
- The spec does not say whether some routes can refuse the fallback instead of using the address.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): B-13
- [client-address](client-address.md)
- [fallback-token-bucket](fallback-token-bucket.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit-subject](rate-limit-subject.md)
- [subject-extractor](subject-extractor.md)
<!-- used-by:end -->
